// Why (#352 R5-B1, R5-F1, R5-F2): a loop's body runs again after it ran, so a command early in the body meets what the body itself left behind (a branch, an alias, a push.default change): the
// second iteration of `for i in 1 2; do git push origin HEAD; npm run setup; done` pushes the branch `setup` switched to. The guard walked a body once, forward only, and its first fix for loop words
// replayed the WHOLE text from the whole line's differences, which lost a switch made before the loop (R5-B1) and refused changes made before or after it (R5-F1).
// (R6: what one reading of a loop word leaves IS carried into every other reading, and the carry is taken after every body command, a loop being judged to a fixpoint: guard-loop-fixpoint.test.mjs.)
// Rule held here: every loop (for / while / until, with or without an unsure variable, on a line or in a script) is judged from its entry state, and again from entry + what the BODY left (the carry)
// until nothing grows; changes outside the loop are never part of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const GIT_ROOT = '/work/repo';
const PB = 'git ' + PUSH; // a bare push
const SWITCH_MAIN = 'git switch ' + MAIN;
const SHIP = 'git config alias.ship "' + PUSH + ' origin ' + MAIN + '"';

function fakeFs(root, files) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u'].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
// (the repository at GIT_ROOT is on agent/x; any other directory, /work/other for one, is a repository on main)
const run = (cmd, files = {}) => evaluateGitCommand(cmd, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files),
});
// package.json whose `setup` script is `setup`; `other` is harmless
const pkg = (setup) => ({ 'package.json': JSON.stringify({ name: 'x', scripts: { setup, other: 'echo hi' } }) });
const script = (setup, text) => ({ ...pkg(setup), 'run.sh': `#!/bin/bash\n${text}\n` });
const RUN_SH = `bash ${GIT_ROOT}/run.sh`;
const BRANCH = /cannot determine the current branch/;
const ALIAS = /the git alias "ship" may have been \(re\)defined/;
const DIRS = /cannot determine the current branch|pushing to main is blocked/; // (the next iteration's directory is a repository on main, or is not known)
const CONFIG = /changes upstream\/push configuration/;

function denies(what, cmd, files, reason) {
  const r = run(cmd, files);
  assert.equal(r.decision, 'deny', `${what}: allowed`);
  assert.match(r.reason, reason, `${what}: ${r.reason}`);
}
function allows(what, cmd, files) {
  const r = run(cmd, files);
  assert.equal(r.decision, 'allow', `${what}: ${r.reason}`);
}

test('#352 R5-B1: a branch switched BEFORE the loop does not hide what the loop body leaves for its next iteration', () => {
  denies('line', `git switch agent/x; for s in setup other; do ${PB} origin HEAD; npm run $s; done`, pkg(SWITCH_MAIN), BRANCH);
  denies('script', RUN_SH, script(SWITCH_MAIN, `git switch agent/x; for s in setup other; do ${PB} origin HEAD; npm run $s; done`), BRANCH);
  denies('prefix alias', `git config alias.st status; for s in setup other; do git ship; npm run $s; done`, pkg(SHIP), ALIAS);
});

test('#352 R5-F2: a loop with no variable that reaches a command is judged for its next iteration too (for / while / until, on the line or in a script)', () => {
  const body = `${PB} origin HEAD; npm run setup`;
  for (const [what, loop] of [['for', `for i in 1 2; do ${body}; done`], ['while', `while [ ! -f stop ]; do ${body}; done`], ['until', `until [ -f stop ]; do ${body}; done`]]) {
    denies(`${what} on the line`, loop, pkg(SWITCH_MAIN), BRANCH);
    denies(`${what} in a script`, RUN_SH, script(SWITCH_MAIN, loop), BRANCH);
  }
  denies('nested loops', `for i in 1 2; do for j in a b; do ${PB} origin HEAD; done; npm run setup; done`, pkg(SWITCH_MAIN), BRANCH);
  denies('a loop in a function body', `f() { for i in 1 2; do ${body}; done; }; f`, pkg(SWITCH_MAIN), BRANCH);
});

test('#352 R5-F2: a state change made directly late in the body reaches the early commands of the next iteration', () => {
  denies('switch', `for i in 1 2; do ${PB} origin HEAD; git switch ${MAIN}; done`, {}, BRANCH);
  denies('checkout', `while true; do ${PB} origin HEAD; git checkout ${MAIN}; done`, {}, BRANCH);
  denies('alias', `for i in 1 2; do git ship; ${SHIP}; done`, {}, ALIAS);
  denies('alias, in a script', RUN_SH, script('echo', `while true; do git ship; ${SHIP}; done`), ALIAS);
  denies('push.default', `for i in 1 2; do ${PB}; git config push.default upstream; done`, {}, CONFIG);
  denies('branch -u', `for i in 1 2; do ${PB}; git branch -u origin/${MAIN}; done`, {}, CONFIG);
  denies('alias through a package script', `for i in 1 2; do git ship; npm run setup; done`, pkg(SHIP), ALIAS);
  denies('push.default through a package script', `until false; do ${PB}; npm run setup; done`, pkg('git config push.default upstream'), CONFIG);
});

test('#352 R5-F1 allow twins: a change made before or after the loop is not carried into its body', () => {
  allows('alias made before the loop, used in it', 'git config alias.st status; for f in a b; do git st $f; done');
  allows('branch switched after the loop', `for f in a b; do git add $f; git commit -m $f; ${PB} origin HEAD; done; git switch ${MAIN}`);
  allows('push.default after the loop', `for f in a b; do git add $f; ${PB}; done; git config push.default upstream`);
  allows('branch -u after the loop', `for f in a b; do git add $f; ${PB}; done; git branch -u origin/${MAIN}`);
  allows('alias made after the loop', `for f in a b; do git ship; done; ${SHIP}`);
  allows('in a script', RUN_SH, script('echo', `git config alias.st status; for f in a b; do git st $f; done; git switch ${MAIN}`));
});

test('#352 R5 allow twins: a branch made before the loop, a switch inside it, or a loop that leaves no git state is not refused', () => {
  allows('checkout -b before, push after', `git checkout -b agent/x; for f in a b; do git add $f; done; ${PB} -u origin HEAD`);
  allows('switch and push in the body', `for b in agent/a agent/b; do git switch $b && ${PB} origin HEAD; done`);
  allows('switch and push in the body, then a switch after', `for b in agent/a agent/b; do git switch $b && ${PB} origin HEAD; done; git switch ${MAIN}`);
  allows('no git state', 'for f in a b; do echo $f; done');
  allows('no git state, a push after', `for i in 1 2; do echo $i; git status; done; ${PB} origin HEAD`);
  allows('while read, a push after', `while read l; do echo $l; done < f; ${PB} origin HEAD`);
  allows('two loops one after the other', 'for f in a b; do git add $f; done; for g in c d; do git commit -m $g; done');
  allows('a harmless package script in a loop', `for i in 1 2; do ${PB} origin HEAD; npm run other; done`, pkg(SWITCH_MAIN));
  allows('a harmless setup script', `while true; do ${PB} origin HEAD; npm run setup; done`, pkg('echo setup'));
  allows('a harmless alias in a loop', 'for i in 1 2; do git ship; git config alias.st status; done');
});

// Why (#352 R5, directory loop-back): a body that moves to another directory starts its next iteration THERE: `git push origin HEAD; cd /work/other` pushes /work/other's branch the second time round.
// The body is judged again from the directory it ended in (unknown when it cannot be named), then from an unknown one when that moves again (`cd ..` goes up every time).
test('#352 R5: a directory the body changes to is where its next iteration starts', () => {
  for (const [what, loop] of [
    ['absolute cd', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; done`],
    ['relative cd', `for i in 1 2; do ${PB} origin HEAD; cd ../other; done`],
    ['cd to a variable', `X=/work/other; for i in 1 2; do ${PB} origin HEAD; cd "$X"; done`],
    ['pushd', `for i in 1 2; do ${PB} origin HEAD; pushd /work/other; done`],
    ['cd up every time', `while true; do ${PB} origin HEAD; cd ..; done`],
    ['cd chained', `for i in 1 2; do ${PB} origin HEAD; cd ../other && echo; done`],
    ['cd to a place not named', `for i in 1 2; do ${PB} origin HEAD; cd "$(mktemp -d)"; done`],
  ]) {
    denies(what, loop, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', loop), DIRS);
  }
});
test('#352 R5 allow twins: a body that stays in the repository, or moves only in a subshell, is not refused', () => {
  allows('cd into a subdirectory and push, then back', `for i in 1 2; do cd sub && ${PB} origin HEAD; cd ..; done`);
  allows('cd into a subdirectory of the repository by its full path', `for i in 1 2; do cd ${GIT_ROOT}/sub && ${PB} origin HEAD; done`);
  allows('push, then cd into a subdirectory by its full path', `for i in 1 2; do ${PB} origin HEAD; cd ${GIT_ROOT}/sub; done`);
  allows('subshell cd before the push', `for i in 1 2; do (cd sub && make); ${PB} origin HEAD; done`);
  allows('subshell cd to another repository after the push', `for i in 1 2; do ${PB} origin HEAD; (cd /work/other && make); done`);
  allows('command substitution cd', `for i in 1 2; do ${PB} origin HEAD; echo $(cd /work/other && pwd); done`);
  allows('cd and back', `for i in 1 2; do ${PB} origin HEAD; cd sub && cd ..; done`);
  allows('cd to the repository itself', `for i in 1 2; do ${PB} origin HEAD; cd ${GIT_ROOT}; done`);
  allows('cd into another repository, no push in the loop', 'for i in 1 2; do cd /work/other; git status; done');
  allows('in a script', RUN_SH, script('echo', `for i in 1 2; do (cd sub && make); ${PB} origin HEAD; cd ${GIT_ROOT}/sub; done`));
});
// (#352 R28-F1: `cd a && cd b` moves twice or not at all only when the second cd moves this shell as surely as the first: one a wrapper starts, one in a pipeline stage or the background,
// one whose redirection may fail, chdir (no builtin in bash), or a pair whose first cd is negated (`! cd a && cd b`: b runs only when a FAILED) may leave the body in a)
test('#352 R28-F1: the cd-pair shortcut holds only when the second cd surely moves this shell', () => {
  for (const [what, loop] of [
    ['second cd started by a wrapper', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && env cd ${GIT_ROOT}; done`],
    ['second cd in a pipeline stage', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd ${GIT_ROOT} | cat; done`],
    ['second cd with a redirection that may fail', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd ${GIT_ROOT} < /missing; done`],
    ['second cd is chdir', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && chdir ${GIT_ROOT}; done`],
    ['second cd in the background', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd ${GIT_ROOT} & done`],
    ['first cd negated', `for i in 1 2; do ${PB} origin HEAD; ! cd /work/other && cd ${GIT_ROOT}; done`],
  ]) {
    denies(what, loop, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', loop), DIRS);
  }
  allows('a plain pair out and back', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd ${GIT_ROOT}; done`);
  allows('a plain pair out and back, in a script', RUN_SH, script('echo', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd ${GIT_ROOT}; done`));
});
// (#352 R29-B1, R29-F1, R29-F2: an option word the shell refuses (`cd -Q`) fails the cd, which stays where it was, and bash's `pushd -n DIR` succeeds without moving: the directory a cd / pushd
// leaves is known only for the options that cannot fail or skip the move (-L, -P; `--` ends the options), in a loop's replay and on the straight line alike)
test('#352 R29-B1/F1/F2: a cd or pushd with an option outside -L / -P leaves the directory unknown', () => {
  for (const [what, line] of [
    ['failing option, in a pair (R29-B1)', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd -Q ${GIT_ROOT}; done`],
    ['failing option, after ; (R29-F1)', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; cd -Q ${GIT_ROOT}; done`],
    ['pushd -n in a loop (R29-F2)', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && pushd -n ${GIT_ROOT}; done`],
    ['pushd -n on the straight line (R29-F2)', `cd /work/other && pushd -n ${GIT_ROOT} && ${PB} origin HEAD`],
    ['failing option on the straight line, after ;', `cd /work/other; cd -Q ${GIT_ROOT}; ${PB} origin HEAD`],
    ['zsh cd -s (refuses a symbolic link)', `cd /work/other && cd -s ${GIT_ROOT} && ${PB} origin HEAD`],
  ]) {
    denies(what, line, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', line), DIRS);
  }
  allows('cd -P back to the repository', `cd /work/other && cd -P ${GIT_ROOT} && ${PB} origin HEAD`);
  allows('cd -L -- back to the repository', `cd /work/other && cd -L -- ${GIT_ROOT} && ${PB} origin HEAD`);
  allows('cd -LP back, in a loop', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && cd -LP ${GIT_ROOT}; done`);
  allows('cd -P into a subdirectory and back, in a loop', `for i in 1 2; do ${PB} origin HEAD; cd -P sub && cd ..; done`);
});
// (#352 R30-F3: options, and the `--` that ends them, count only before the first operand. `cd DIR -P` is zsh's two-word `cd OLD NEW` (bash: "too many arguments") and fails, so it stays where it was;
// `cd DIR --` fails the same way and is no bare cd (HOME). The R29 rows again with the dash word after the operand.)
test('#352 R30-F3: a -P / -- after the cd operand makes the cd fail (two operands): the directory is unknown', () => {
  for (const tail of ['-P', '--', '-L']) {
    const cd = `cd ${GIT_ROOT} ${tail}`;
    for (const [what, line] of [
      ['in a pair', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && ${cd}; done`],
      ['after ;', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; ${cd}; done`],
      ['on the straight line, after &&', `cd /work/other && ${cd} && ${PB} origin HEAD`],
      ['on the straight line, after ;', `cd /work/other; ${cd}; ${PB} origin HEAD`],
      ['pushd first, then the cd, in a loop', `for i in 1 2; do ${PB} origin HEAD; cd /work/other && pushd -n ${GIT_ROOT}; ${cd}; done`],
      ['pushd -n first on the straight line', `cd /work/other && pushd -n ${GIT_ROOT} && ${cd} && ${PB} origin HEAD`],
    ]) {
      denies(`${cd} ${what}`, line, {}, DIRS);
      denies(`${cd} ${what}, in a script`, RUN_SH, script('echo', line), DIRS);
    }
  }
  // (the options before the operand still move: the allows of R29 stand)
  allows('cd -P first, then the operand', `cd /work/other && cd -P ${GIT_ROOT} && ${PB} origin HEAD`);
  allows('cd -L x', `cd /work/other && cd -L ${GIT_ROOT} && ${PB} origin HEAD`);
  allows('cd -- operand', `cd /work/other && cd -- ${GIT_ROOT} && ${PB} origin HEAD`);
  allows('cd -P sub && cd .. in a loop', `for i in 1 2; do ${PB} origin HEAD; cd -P sub && cd ..; done`);
});
// (#352 R35-B1, R35-B2, R35-F1, R35-F2: ONE rule. A cd / state change is trusted to have run only when it surely did: in a loop's replay a cd REPLACES the places the body may end in only when it is
// certain there (after ;, not in a branch, an inner loop, the background or a pipeline stage, not negated, every level between the loop and it entered by ;, no redirection that can fail on it, on the
// closer of its { } group or on the eval that holds it); any other ADDS its target. A `continue` that reaches the loop ends an iteration where it stands. On the straight line, a change with a
// redirection that can fail is not certain (the directory / branch after it is unknown). (#352 R36: NO redirection is firm, see the R36 test below; R37: no exception for &&, the row "cd back with &>/dev/null after &&" that stood here is a deny there.)
test('#352 R35-B1/B2/F1/F2: a cd or state change that may not have run is not trusted', () => {
  const loopRows = [
    ['failing redirection on the cd back (R35-B1)', `cd /work/other; cd ${GIT_ROOT} < /missing`],
    ['failing output redirection on the cd back', `cd /work/other; cd ${GIT_ROOT} > /missing/f`],
    ['failing redirection on the { } group closer', `cd /work/other; { cd ${GIT_ROOT}; } < /missing`],
    ['failing redirection on the eval that holds the cd', `cd /work/other; eval 'cd ${GIT_ROOT}' < /missing`],
    ['continue before the cd back (R35-B2)', `cd /work/other; continue; cd ${GIT_ROOT}`],
    ['conditional continue before the cd back', `cd /work/other; [ -f stop ] && continue; cd ${GIT_ROOT}`],
    ['continue 2 from an inner loop', `cd /work/other; for j in a; do continue 2; done; cd ${GIT_ROOT}`],
    ['continue in an eval text', `cd /work/other; eval continue; cd ${GIT_ROOT}`],
    ['cd back in a while loop that runs zero times (R35-F1)', `cd /work/other; while false; do cd ${GIT_ROOT}; done`],
    ['cd back in a for loop over no words', `cd /work/other; for j in; do cd ${GIT_ROOT}; done`],
    ['cd back in an eval behind &&', `cd /work/other; false && eval 'cd ${GIT_ROOT}'`],
    ['cd back in an eval behind ||', `cd /work/other; true || eval 'cd ${GIT_ROOT}'`],
    ['cd back in an eval in the background', `cd /work/other; eval 'cd ${GIT_ROOT}' &`],
    ['cd back in an eval piped', `cd /work/other; eval 'cd ${GIT_ROOT}' | cat`],
    ['cd back in an if branch', `cd /work/other; if [ -f x ]; then cd ${GIT_ROOT}; fi`],
    ['relative cd in an inner loop moves again every time', `cd ${GIT_ROOT}/a/b; while [ ! -f stop ]; do cd ..; done`],
  ];
  for (const [what, body] of loopRows) {
    const loop = `for i in 1 2; do ${PB} origin HEAD; ${body}${body.endsWith('&') ? '' : ';'} done`; // (`… & done`: `&;` is a syntax error)
    denies(what, loop, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', loop), DIRS);
  }
  for (const [what, line] of [
    ['straight line: failing redirection on the cd back (R35-F2)', `cd /work/other; cd ${GIT_ROOT} < /missing; ${PB} origin HEAD`],
    ['straight line: failing redirection on the { } group closer', `cd /work/other; { cd ${GIT_ROOT}; } < /missing; ${PB} origin HEAD`],
    ['straight line: failing redirection on the switch', `cd /work/other; git switch agent/x < /missing; ${PB} origin HEAD`],
    // (zsh writes a here-document to a temporary file first: TMPPREFIX=/missing/x makes it fail, and the cd does not run (zsh 5.9))
    ['straight line: a here-document on the cd back', `TMPPREFIX=/missing/x; cd /work/other; cd ${GIT_ROOT} <<E\nx\nE\n${PB} origin HEAD`],
  ]) {
    denies(what, line, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', line), DIRS);
  }
  for (const [what, line] of [
    ['cd back in an eval after ;', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; eval 'cd ${GIT_ROOT}'; done`],
    ['continue of an inner loop only', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; for j in a; do continue; done; cd ${GIT_ROOT}; done`],
    ['break before the cd back (no next iteration from there)', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; if [ -f stop ]; then break; fi; cd ${GIT_ROOT}; done`],
    ['a zero-run inner loop, then the cd back', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; while false; do cd /tmp; done; cd ${GIT_ROOT}; done`],
    ['continue after the cd back', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; cd ${GIT_ROOT}; continue; done`],
    ['straight line: a bare >x in the { } group is no closer', `cd /work/other; { cd ${GIT_ROOT}; >x; }; ${PB} origin HEAD`],
    ['a bare >x in the { } group is no closer, in a loop', `for i in 1 2; do ${PB} origin HEAD; cd /work/other; { cd ${GIT_ROOT}; >x; }; done`],
    ['straight line: a failing redirection on a command that moves nothing', `cd ${GIT_ROOT}; git branch -a > /missing/f; ${PB} origin HEAD`],
  ]) {
    allows(what, line);
    allows(`${what}, in a script`, RUN_SH, script('echo', line));
  }
});
// (#352 R36, the final simple rule: NO redirection is firm. A cd / state change carrying any redirection (`2>/dev/null`, `>&2`, `2>&1`, a heredoc ...) may not have run: `exec 2>&-; cd d >&2` fails
// (bad descriptor) and so does `ulimit -S -n 3; cd d 2>/dev/null` (too many open files). A failed redirection makes the command exit non-zero, so the command chained to it with && still runs only when it ran.)
test('#352 R36-B1/F2: no redirection on a cd or state change is trusted (the R35 allows with 2>/dev/null, >&2, &>/dev/null flip to deny)', () => {
  const loopRows = [
    ['closed stderr, cd back with >&2 (R36-B1)', `exec 2>&-; cd /work/other; cd ${GIT_ROOT} >&2`],
    ['closed stderr, cd back with 2>&1', `exec 1>&-; cd /work/other; cd ${GIT_ROOT} 2>&1`],
    ['lowered descriptor limit, cd back with 2>/dev/null (R36-F2)', `ulimit -S -n 3; cd /work/other; cd ${GIT_ROOT} 2>/dev/null; ulimit -S -n 256`],
    ['cd back with 2>/dev/null (R35 allow flipped)', `cd /work/other; cd ${GIT_ROOT} 2>/dev/null`],
    ['cd back with >/dev/null 2>&1 (R35 allow flipped)', `cd /work/other; cd ${GIT_ROOT} >/dev/null 2>&1`],
    ['cd back in a { } group with 2>/dev/null on its closer (R35 allow flipped)', `cd /work/other; { cd ${GIT_ROOT}; } 2>/dev/null`],
  ];
  for (const [what, body] of loopRows) {
    const loop = `for i in 1 2; do ${PB} origin HEAD; ${body}; done`;
    denies(what, loop, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', loop), DIRS);
  }
  for (const [what, line] of [
    ['straight line: closed stderr, cd back with >&2 (R36-B1)', `exec 2>&-; cd /work/other; cd ${GIT_ROOT} >&2; ${PB} origin HEAD`],
    ['straight line: closed stderr, cd back with 2>&1', `exec 2>&-; cd /work/other; cd ${GIT_ROOT} 2>&1; ${PB} origin HEAD`],
    ['straight line: lowered descriptor limit, cd back with 2>/dev/null (R36-F2)', `cd /work/other; ulimit -S -n 3; cd ${GIT_ROOT} 2>/dev/null; ulimit -S -n 256; ${PB} origin HEAD`],
    ['straight line: lowered descriptor limit, switch with 2>/dev/null', `ulimit -S -n 3; git switch agent/x 2>/dev/null; ulimit -S -n 256; ${PB} origin HEAD`],
    ['straight line: switch with 2>/dev/null (R35 allow flipped)', `cd /work/other; git switch agent/x 2>/dev/null; ${PB} origin HEAD`],
    ['straight line: cd back with 2>/dev/null (R35 allow flipped)', `cd /work/other; cd ${GIT_ROOT} 2>/dev/null; ${PB} origin HEAD`],
    ['straight line: cd back with >&2 (R35 allow flipped)', `cd /work/other; cd ${GIT_ROOT} >&2; ${PB} origin HEAD`],
    // (|| exit: sound to allow, since a failed redirection makes the cd fail and the exit runs, but the narrowing only knows a command with no redirection: refused, no new machinery)
    ['straight line: cd back with 2>/dev/null || exit 1, then ;', `cd /work/other; cd ${GIT_ROOT} 2>/dev/null || exit 1; ${PB} origin HEAD`],
    ['straight line: cd back with 2>/dev/null, then another command, then ;', `cd /work/other; cd ${GIT_ROOT} 2>/dev/null && true; ${PB} origin HEAD`],
  ]) {
    denies(what, line, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', line), DIRS);
  }
  // (#352 R37-F1: no exception for &&: a redirected change is unknown at once, so a script ending in a redirected switch cannot hand it to its caller. R36 allowed these rows through a 'chain' tracker nothing settled at the end of a text)
  for (const [what, line] of [
    ['cd back with 2>/dev/null && push (R36 allow flipped)', `cd /work/other; cd ${GIT_ROOT} 2>/dev/null && ${PB} origin HEAD`],
    ['cd back with >&2 && push (R36 allow flipped)', `cd /work/other; cd ${GIT_ROOT} >&2 && ${PB} origin HEAD`],
    ['cd back with &>/dev/null && push (R36 allow flipped)', `cd /work/other && cd ${GIT_ROOT} &>/dev/null && ${PB} origin HEAD`],
    ['failing redirection on the cd back, then && push', `cd /work/other && cd ${GIT_ROOT} > /missing/f && ${PB} origin HEAD`],
    ['failing redirection on the checkout, then && push', `cd /work/other && git checkout agent/x > /missing/f && ${PB} origin HEAD`],
  ]) {
    denies(what, line, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', line), DIRS);
  }
});
// (#352 R37-F1: the caller trusts the branch a definite script ends on, so a script whose LAST command is a switch that may not have run (a redirection that can fail, a && after a failing command) must not hand it over:
// cwd a repository on main, reset.sh = `git switch agent/x > /missing/f`, the line `bash ./reset.sh; <push>` sends main when the redirection fails)
test('#352 R37-F1: a script / package script that ends in a redirected or conditional switch does not hand the switched branch to its caller', () => {
  const at = (cmd, files) => evaluateGitCommand(cmd, {
    cwd: '/work/other', home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) ? 'agent/x' : MAIN), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs('/work/other', files),
  });
  const files = (body) => ({ 'reset.sh': `#!/bin/bash\n${body}\n`, 'package.json': JSON.stringify({ name: 'x', scripts: { reset: body, other: 'echo hi' } }) });
  // (#352 R37-F1, same root: a switch that only a branch body made (if / elif / else / case, a function body, a loop over words not named) is as unsettled when the text ends)
  const bodies = [
    'git switch agent/x > /missing/f', 'git switch agent/x 2>/dev/null', 'false && git switch agent/x',
    'if [ -f x ]; then git switch agent/x; fi', 'if [ -f x ]; then :; elif [ -f y ]; then git switch agent/x; fi', 'if [ -f x ]; then :; else git switch agent/x; fi',
    'case "$1" in a) git switch agent/x;; esac', 'if [ -f x ]; then true && git switch agent/x; fi', 'f() { git switch agent/x; }',
    'for b in $(ls); do git switch agent/x; done', 'while [ -f x ]; do git switch agent/x; done', 'for b in agent/x agent/x; do [ -f x ] && git switch $b; done',
  ];
  for (const body of bodies) {
    for (const [what, caller] of [['bash script', 'bash ./reset.sh'], ['package script', 'npm run reset']]) {
      for (const sep of [';', '&&']) {
        const r = at(`${caller} ${sep} ${PB} origin HEAD`, files(body));
        assert.equal(r.decision, 'deny', `${what} ending in \`${body}\`, then ${sep}: allowed`);
        assert.match(r.reason, DIRS, `${what} \`${body}\` ${sep}: ${r.reason}`);
      }
    }
  }
  // (twins: the same script with a plain switch hands it over, and so does a loop over a literal non-empty list of words (its body surely ran))
  for (const body of ['git switch agent/x', 'for b in agent/x agent/x; do git switch $b; done']) {
    for (const [what, caller] of [['bash script', 'bash ./reset.sh'], ['package script', 'npm run reset']]) {
      for (const sep of [';', '&&']) {
        const r = at(`${caller} ${sep} ${PB} origin HEAD`, files(body));
        assert.equal(r.decision, 'allow', `twin ${what} ${sep} \`${body}\`: ${r.reason}`);
      }
    }
  }
});
// (#352 R36-F1: a loop's own level and depth come from the whole of its range, not from its first listed command, which is a command of a substitution / group / loop in its header)
test('#352 R36-F1: a loop whose header holds a substitution, a group or a loop is judged at its own level', () => {
  const body = (inner) => `${PB} origin HEAD; cd /work/other; ${inner}`;
  const heads = [
    ['for over a substitution', (b) => `for i in $(echo 1 2); do ${b}; done`],
    ['while on a substitution', (b) => `while test "$(cat f)" = go; do ${b}; done`],
    ['while on a { } group', (b) => `while { true; }; do ${b}; done`],
    ['for over a substitution holding a loop', (b) => `for i in $(for j in a; do echo $j; done); do ${b}; done`],
  ];
  const inners = [
    ['a cd in an eval behind &&', `false && eval 'cd ${GIT_ROOT}'`],
    ['a cd in a { } group with a failing redirection', `{ cd ${GIT_ROOT}; } < /missing`],
    ['a cd in a loop that runs zero times', `while false; do cd ${GIT_ROOT}; done`],
  ];
  for (const [hw, head] of heads) {
    for (const [iw, inner] of inners) {
      const loop = head(body(inner));
      denies(`${hw}: ${iw}`, loop, {}, DIRS);
      denies(`${hw}: ${iw}, in a script`, RUN_SH, script('echo', loop), DIRS);
    }
  }
  // (allow twins: the cd back surely runs, whatever the header holds)
  for (const [hw, head] of heads) {
    const loop = head(body(`cd ${GIT_ROOT}`));
    allows(`${hw}: a plain cd back`, loop);
    allows(`${hw}: a plain cd back, in a script`, RUN_SH, script('echo', loop));
  }
  allows('for over a substitution: stays in the repository', `for i in $(echo 1 2); do cd sub && ${PB} origin HEAD; cd ..; done`);
});

// (#352 R37-F2: a loop's own level and depth are not inferred from the commands listed in its range: with no command at its own level (a while / until header that is a group or a loop, the whole body in { } groups or inner loops) the
// shortest one is one level too deep, and the cd back that never ran (a failing redirection on its group, an inner loop that runs zero times) was trusted)
test('#352 R37-F2: a loop with no command at its own level keeps its own level and depth', () => {
  const rows = [
    ['while on a { } group, the body all in { } groups: a failing redirection on the cd back',
      `while { true; }; do { ${PB} origin HEAD; }; { cd /work/other; }; { cd ${GIT_ROOT}; } < /missing; done`,
      `while { true; }; do { ${PB} origin HEAD; }; { cd /work/other; }; { cd ${GIT_ROOT}; }; done`],
    ['while on a loop, the body all in inner loops: a cd back in a loop that runs zero times',
      `while for j in a; do true; done; do for k in 1; do ${PB} origin HEAD; done; for k in 1; do cd /work/other; done; while false; do cd ${GIT_ROOT}; done; done`,
      `while for j in a; do true; done; do for k in 1; do ${PB} origin HEAD; done; for k in 1; do cd /work/other; done; cd ${GIT_ROOT}; done`],
  ];
  for (const [what, deny, twin] of rows) {
    denies(what, deny, {}, DIRS);
    denies(`${what}, in a script`, RUN_SH, script('echo', deny), DIRS);
    allows(`${what}: plain cd back`, twin);
    allows(`${what}: plain cd back, in a script`, RUN_SH, script('echo', twin));
  }
});
