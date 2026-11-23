// Why (issue #81, security follow-up after t7): a security review flagged a parser differential in the readings: places where the SHELL assigns or changes a variable but the
// guard does not see it, so a script choice (`bash s$n.sh`) was judged with the wrong value. Probed against real bash and zsh (every shape below was run in both; a shape only one
// shell honours says so), each is a bypass in BOTH guards unless noted, and most were already open on main (3651520); t7's text scan only knew `((` `$[` `let` and only for a name the
// line had given a value first. Each shape runs the script s7.sh (the fake file holds a guarded command) while the name still reads 2 (s2.sh is harmless) to the guard:
//   - arithmetic contexts that are no `$(( ))`: a `[[ x -eq n=7 ]]` operand (bash and zsh evaluate -eq -ne -lt -le -gt -ge operands; `[ ]` and `test` do not), an array subscript
//     (`${a[n=7]}`, `a[n=7]=x`, `${a[n++]}`, `${#a[n=7]}`, zsh `$x[n=7]`), a substring offset (`${x:n=3:1}`, `${a[@]:n=1}`);
//   - blanks and `++` the git guard never read (`$(( n = 7 ))`, `((n++))`, `$((n++))`, `while ((n++ < 7))`, `$[n=7]`: the files guard had them since t7, the git guard had none);
//   - `n+=7.sh` (append): the parser keeps `n` = `7.sh` (the files guard judged the new text, not old + new), and `export n+=` / `declare n+=` were not read at all;
//   - a name nothing set before (`(( n += 7 )); bash s$n.sh`, `let n+=7`): t7 marked only a name the line had given, so the guard read the empty value;
//   - zsh `integer n` / `float n` / `typeset -F n` (the integer / float attribute makes `n=2+5` arithmetic; the git guard refused the binder, the files guard did not);
//   - an unquoted heredoc / here-string body expands `$(( ))` in the current shell (`: <<EOF` + `$((n+=5))`): scanned as command text. A QUOTED delimiter does not expand: its body is data
//     (t7 made the files guard refuse a quoted body that merely shows `$((n=7))`; that is a new false alarm and is allowed again).
// Each deny has a harmless twin that must stay allowed. The file system is faked; guarded text only lives in fake file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { execFileSync } from 'node:child_process';
import { arithAssignedNames, simpleCommands, SHELL_SUPPLIED_TEXT, SHELL_SUPPLIED_NUMBERS } from '../pipeline/hooks/lib/shell-parse.mjs';
import { EVAL_DEADLINE_MS } from '../pipeline/hooks/lib/script-candidates.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
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

const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const BAD_GIT = 'git ' + 'push origin main'; // (split so a hook that scans this file for a guarded command does not take the fixture for one)
const BAD_FILES = 'echo x > ~/.' + 'claude/settings.json';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
function both(command, spec) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'))),
    files: files(command, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'))),
  };
}
// s7 / s1 / s3 / s8 hold the guarded command; s2 / s0 and a missing name are harmless. Every case starts with the name at a harmless value (2 or 0, or unset).
const SPEC = { 's7.sh': 'bad', 's1.sh': 'bad', 's3.sh': 'bad', 's8.sh': 'bad', 's2.sh': 'ok', 's0.sh': 'ok', 's.sh': 'ok' };
const allow = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'allow', `git: ${cmd} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${cmd} -> ${r.files.reason}`);
};
const deny = (cmd, spec = SPEC) => {
  const r = both(cmd, spec);
  assert.equal(r.git.decision, 'deny', `git allowed: ${cmd}`);
  assert.equal(r.files.decision, 'deny', `files allowed: ${cmd}`);
};
const denyEach = (cmds) => { for (const c of cmds) deny(c); };

test('a [[ ]] operand of -eq / -ne / -lt / -le / -gt / -ge is arithmetic: an assignment there changes the name', () => {
  denyEach([
    '[[ n=7 -eq 7 ]]; bash s$n.sh', // (the name was never set: the guard read the empty value)
    'n=2; [[ n=7 -eq 7 ]]; bash s$n.sh',
    'n=2; [[ $x -eq n=7 ]]; bash s$n.sh',
    'n=2; [[ n=7 -eq 7 ]] && bash s$n.sh',
    'n=2; if [[ n=7 -eq 7 ]]; then :; fi; bash s$n.sh',
    'n=2; [[ 1 -lt n=7 ]]; bash s$n.sh',
    'n=2; [[ "n = 7" -ge 7 ]]; bash s$n.sh',
    'n=2; [[ -z $q && n+=5 -ne 0 ]]; bash s$n.sh',
  ]);
});

test('a [[ ]] without an arithmetic operator, and [ ] / test, assign nothing', () => {
  for (const c of [
    'n=2; [ n=7 -eq 7 ]; bash s$n.sh',
    'n=2; test n=7 -eq 7; bash s$n.sh',
    'n=2; [[ n=7 == n=7 ]]; bash s$n.sh',
    'n=2; [[ $n -eq 2 ]] && bash s$n.sh',
    'n=2; [[ $n -gt 1 && -n $x ]]; bash s$n.sh',
    'n=2; [[ $x = b=1 ]]; bash s$n.sh',
  ]) allow(c);
});

test('an array subscript is arithmetic: an assignment in it changes the name', () => {
  denyEach([
    'a=(1 2 3 4 5 6 7 8); n=2; echo ${a[n=7]}; bash s$n.sh',
    'n=2; echo "${a[n=7]}"; bash s$n.sh',
    'n=2; a[n=7]=x; bash s$n.sh',
    'n=0; a=(1 2 3); echo ${a[n++]}; bash s$n.sh', // (runs s1.sh)
    'n=2; a=(1 2); echo ${#a[n=7]}; bash s$n.sh',
    'n=2; declare a[n=7]=x; bash s$n.sh',
    'n=2; a=(1); printf "%s" ${a[n=7]}; bash s$n.sh',
    'n=2; [ ${a[n=7]:-0} -eq 0 ]; bash s$n.sh',
    'n=2; x=abcdef; echo ${x[n=3]}; bash s$n.sh', // (zsh and bash)
    'n=2; x=abcdef; echo $x[n=3]; bash s$n.sh', // (zsh reads the bare subscript)
    'n=2; x=abcdef; echo ${a[ n = 7 ]}; bash s$n.sh',
  ]);
});

test('a subscript that only reads, and a glob class, assign nothing', () => {
  for (const c of [
    'n=2; a=(1 2); echo ${a[1]} ${a[n]} ${#a[@]}; bash s$n.sh',
    'n=2; ls f[ab] g[0-9]; bash s$n.sh',
    'n=2; a[1]=x; echo ${a[1]}; bash s$n.sh',
    'n=2; echo ${a[$n]}; bash s$n.sh',
  ]) allow(c);
});

test('a substring offset is arithmetic: an assignment in it changes the name', () => {
  denyEach([
    'n=2; x=abcdefgh; echo ${x:n=3:1}; bash s$n.sh', // (bash)
    'n=2; x=abcdef; echo ${x:n=3}; bash s$n.sh',
    'n=2; x=abcdef; echo ${x: n=3 : 1}; bash s$n.sh',
    'n=2; a=(1 2 3 4); echo ${a[@]:n=1}; bash s$n.sh',
  ]);
});

test('${x:-default}, ${x:+alt}, ${x:?msg} and a harmless offset assign nothing', () => {
  for (const c of [
    'n=2; x=abcdef; echo ${x:1:2} ${x: -2} ${x:-n=7} ${x:+n=7}; bash s$n.sh',
    'n=2; echo ${x:-a=b}; bash s$n.sh',
  ]) allow(c);
});

test('blanks and ++ in an arithmetic the git guard did not read', () => {
  denyEach([
    'n=2; echo $(( n = 7 )); bash s$n.sh',
    'n=0; ((n++)); bash s$n.sh', // (runs s1.sh)
    'n=0; echo $((n++)); bash s$n.sh',
    'n=2; while ((n++ < 7)); do :; done; bash s$n.sh', // (runs s8.sh)
    'n=2; echo $[n=7]; bash s$n.sh',
    'n=2; : $((n+=5)); bash s$n.sh',
    '(( n += 7 )); bash s$n.sh', // (the name was never set)
    'let n+=7; bash s$n.sh',
    'n=2; for ((n=0; n<7; n++)); do :; done; bash s$n.sh',
    'for ((n=0; n<7; n++)); do :; done; bash s$n.sh',
  ]);
});

test('arithmetic that only reads a name, or assigns another one, changes nothing for the script choice', () => {
  for (const c of [
    'n=2; echo $((n+5)); bash s$n.sh',
    'n=2; (( n > 1 )); bash s$n.sh',
    'n=2; i=0; ((i++)); echo $i; bash s$n.sh',
    'n=2; for ((i=0; i<3; i++)); do :; done; bash s$n.sh',
    'n=2; m=$((n*2)); bash s$n.sh',
  ]) allow(c);
});

test('n+= appends: the name is no longer the text it was given', () => {
  denyEach([
    'n=s; n+=7.sh; bash $n',
    'n=s; n+=7; bash ${n}.sh',
    'n=s; export n+=7; bash ${n}.sh', // (bash)
    'n=s; declare n+=7; bash ${n}.sh', // (bash)
    'n=s; readonly n+=7; bash ${n}.sh',
    'f() { local n=s; n+=7; bash ${n}.sh; }; f',
  ]);
});

test('an append to a name that picks nothing is no problem', () => {
  for (const c of [
    'args=a; args+=b; echo $args; bash s2.sh',
    'n=2; out=x; out+=y; echo $out; bash s$n.sh',
  ]) allow(c);
});

test('a name with the integer or float attribute holds the value of an arithmetic', () => {
  denyEach([
    'declare -i n; n=2+5; bash s$n.sh',
    'integer n; n=2+5; bash s$n.sh', // (zsh)
    'float n; n=2+5; bash s${n%.*}.sh', // (zsh: 7.0000)
    'typeset -F n; n=2+5; bash s${n%.*}.sh', // (zsh)
    'typeset -E n; n=2+5; bash s${n%.*}.sh', // (zsh)
  ]);
  for (const c of [
    'declare -i m; m=2+5; n=2; bash s$n.sh', // (another name)
  ]) allow(c);
  // (the git guard refuses every zsh binder of names it does not read: `integer m` binds any name for it, as before)
  const r = both('integer m; m=2+5; n=2; bash s$n.sh', SPEC);
  assert.equal(r.files.decision, 'allow', r.files.reason);
});

test('an unquoted heredoc or here-string expands $(( )) in the current shell: its body is scanned like command text', () => {
  denyEach([
    'n=2; : <<EOF\n$(( n = 7 ))\nEOF\nbash s$n.sh',
    'n=2; : <<EOF\n$((n+=5))\nEOF\nbash s$n.sh',
    'n=2; : <<EOF\n${a[n=7]}\nEOF\nbash s$n.sh',
    'n=2; : <<-EOF\n\t$(( n = 7 ))\n\tEOF\nbash s$n.sh',
    'n=2; { cat >/dev/null; } <<EOF\n$((n+=5))\nEOF\nbash s$n.sh',
    'n=0; : <<< "$(( n++ ))"; bash s$n.sh', // (runs s1.sh)
    'n=2; : <<< $(( n += 5 )); bash s$n.sh',
    'n=; : <<EOF\n${n:=7}\nEOF\nbash s$n.sh',
    'n=; : <<< "${n:=7}"; bash s$n.sh',
  ]);
});

test('a QUOTED heredoc delimiter makes the body data: arithmetic written in it assigns nothing (also on main)', () => {
  for (const c of [
    "n=2; : <<'EOF'\n$((n=7))\nEOF\nbash s$n.sh",
    'n=2; : <<\\EOF\n$(( n += 7 ))\nEOF\nbash s$n.sh',
    'n=2; : <<"EOF"\n${a[n=7]}\n[[ n=7 -eq 7 ]]\nEOF\nbash s$n.sh',
    "n=2; cat <<'EOF'\n$((n++)) n+=5 let n=7\nEOF\nbash s$n.sh",
  ]) allow(c);
});

test('the change is found in a script the line runs, too', () => {
  const nested = { 'run.sh': 'n=2\n[[ n=7 -eq 7 ]]\nbash s$n.sh\n', 'run2.sh': 'declare n=2\n(( n += 5 ))\nbash s$n.sh\n', 'run3.sh': 'n=2; : <<EOF\n$((n+=5))\nEOF\nbash s$n.sh\n', ...SPEC };
  deny('bash run.sh', nested);
  deny('bash run2.sh', nested);
  deny('bash run3.sh', nested);
  allow('bash ok.sh', { 'ok.sh': 'n=2\n[[ $n -eq 2 ]]\nbash s$n.sh\n', ...SPEC });
});

test('a name assigned through another name ((( $m = 7 )), m holding n) may be any name', () => {
  denyEach([
    'm=n; n=2; (( $m = 7 )); bash s$n.sh',
    'm=n; n=2; echo $(( $m += 5 )); bash s$n.sh',
  ]);
});

// ---- the readings of nested scripts share one allowance ------------------------------------------------------------------------
// Why: t7 judges a text once per value of a name it assigns twice (16 readings) and the loop words (64) -- and again for every script it runs, so three nested scripts that each assign
// four names twice and loop over eight words were 1024^3 evaluations and ended at the 5 s deadline (main: 0.45 s, allowed). The readings of a whole evaluation share one allowance and
// the check is refused when it is spent (about 0.5 s); the same chain with little to read is still allowed.
const chain = (twice, depth, words, names = 4) => {
  const out = {};
  for (let i = 1; i <= depth; i++) {
    const n = ['a', 'b', 'c', 'd'].map((x) => x + i);
    n.length = 4; // (the call passes all four; the assignments below are for the first `names`)
    const asg = n.slice(0, names).map((x) => (twice ? `${x}=x1; ${x}=x2` : `${x}=x1`)).join('; ');
    const next = i < depth ? `bash F${i + 1}.sh $${n[0]} $${n[1]} $${n[2]} $${n[3]}` : `echo $${n[0]} $${n[1]} $${n[2]} $${n[3]}`;
    out[`F${i}.sh`] = `${asg}\nfor f in ${words}; do echo $${n[0]} $f; done\n${next}\n`;
  }
  return out;
};
// "Refused before the deadline" is proved by a virtual clock, not by a real one: a wall or CPU bound flaked on slow runners (Windows CI measured 2-3x a Mac) whatever its allowance.
// The injected `now` never reads the machine's clock: it advances TICK_MS per call, so the guard's deadline (EVAL_DEADLINE_MS) is reached after a fixed number of calls whatever the
// speed of the machine. The chains below make ~100,000 calls (~1.1 s of virtual time) before the reading cap refuses them; a cap that stopped refusing early would run into the
// virtual deadline instead (a different reason) and fail the same way on every machine.
const TICK_MS = 0.01;
const virtualClock = () => {
  let calls = 0;
  const now = () => calls++ * TICK_MS;
  return { now, elapsed: () => calls * TICK_MS, calls: () => calls };
};
const assertRefusedByReadingCap = (command, fsOpts) => {
  const clock = virtualClock();
  const r = files(command, fsOpts, { now: clock.now });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /too many readings/, r.reason); // (the cap refused it, not the deadline)
  assert.ok(clock.elapsed() < EVAL_DEADLINE_MS / 2, `the refusal came after ${clock.calls()} clock readings (${clock.elapsed()} virtual ms of the ${EVAL_DEADLINE_MS} ms deadline)`);
};
test('the virtual clock advances per call, and a clock past the deadline is refused by the deadline, not the reading cap (the proof above is not vacuous)', () => {
  const clock = virtualClock();
  const t0 = clock.now();
  assert.equal(clock.now() - t0, TICK_MS);
  const late = (() => { let n = 0; return () => (n++ === 0 ? 0 : EVAL_DEADLINE_MS + 1); })(); // (the budget reads it once for its deadline, then it is past it)
  const r = files('bash F1.sh', fakeFs(PROJ, chain(true, 3, 'w1 w2 w3 w4 w5 w6 w7 w8')), { now: late });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /took too long/, r.reason); // (the deadline's own reason)
  assert.doesNotMatch(r.reason, /too many readings/, r.reason);
});
test('three nested scripts that each assign four names twice and loop over eight words are refused at once, not at the deadline', () => {
  assertRefusedByReadingCap('bash F1.sh', fakeFs(PROJ, chain(true, 3, 'w1 w2 w3 w4 w5 w6 w7 w8')));
});
test('a chain with a few readings is still allowed', () => {
  assert.equal(files('bash F1.sh', fakeFs(PROJ, chain(true, 2, 'w1 w2', 2))).decision, 'allow'); // (two names twice, two words: 8 readings a level)
  assert.equal(files('bash F1.sh', fakeFs(PROJ, chain(false, 3, 'w1 w2 w3 w4 w5 w6 w7 w8'))).decision, 'allow'); // (once-assigned names: only the 8 words of each level)
  assert.equal(git('bash F1.sh', fakeFs(GIT_ROOT, chain(false, 3, 'w1 w2 w3 w4 w5 w6 w7 w8'))).decision, 'allow');
});
test('loop words alone (names assigned once) also share the allowance across nested scripts', () => {
  const words = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(' '); // (20 + 20^2 + 20^3 readings)
  assertRefusedByReadingCap('bash F1.sh', fakeFs(PROJ, chain(false, 3, words)));
});

test('program text in quotes (node -e, awk, sed) is no assignment: += and a[i]= in it change nothing', () => {
  for (const c of [
    `n=2; node -e "let s=''; s+='x'; const a=[1]; a[0]=2; console.log(s)"; bash s$n.sh`,
    `n=2; node -e 'let s=""; s+="x"; const a=[1]; a[0]=2; console.log(s)'; bash s$n.sh`,
    `n=2; awk 'BEGIN { x+=1; a[1]=2 }'; bash s$n.sh`,
    `n=2; node <<'EOF'\nlet s=''; s+='x'; a[n=7]=1\nEOF\nbash s$n.sh`,
    `n=2; sed -e 's/a[b]=c/x+=y/' f; bash s$n.sh`,
  ]) allow(c);
});

// ---- a name READ in an arithmetic body (#473, C2b) --------------------------------------------------------------------------------------------------------------------------------
// Why: bash and zsh evaluate a bare name's VALUE as an expression inside arithmetic, so `n=2; i='n=7'; : $((i))` assigns n = 7 while both guards read n = 2 and judged s2.sh (s7.sh ran). A name READ in
// an arithmetic body is trusted only when every value it can hold is a proven plain integer; otherwise the guards' fail-closed `dynamic` reading applies (every name unsure). Each DENY row below ran
// s7.sh on a real shell while both guards allowed it on main (d248f474); each ALLOW row is everyday arithmetic that must not become a refusal.
const P = (pre, use = 'bash s$n.sh') => `n=2; ${pre}; ${use}`;
test('a name read in arithmetic whose value is text (a plain assignment, a command output, a quoted word) can assign any name', () => {
  denyEach([
    P("i='n=7'; : $((i))"), P("i='n=7'; : $(( i + 0 ))"), P("i='n=7'; (( i ))"), P("i='n=7'; let i"), P("i='n=7'; [[ i -eq 0 ]]"), P("i='n=7'; a[i]=x"), P("i='n=7'; : $[i]"),
    P("i='n=7'; : $(( $i ))"), P("i='n=7'; while (( i )); do break; done"), P('i=$(echo n=7); : $((i))'), P('echo hi; : $(( $(cat f) ))'),
  ]);
});
test('printf / print -f evaluate an argument as arithmetic for %d: a text argument (or a format the guard cannot map) can assign any name', () => {
  denyEach([
    P("printf '%d' 'n=7'"), P("i='n=7'; printf '%d' \"$i\""), P("print -f '%d' 'n=7'"), P("printf \"$fmt\" 'n=7'"), P("printf '%2$d %1$s' x 'n=7'"), P("printf '\\045d' 'n=7'"),
    P("printf '%d' \"$@\""), P("printf '%*d' 3 'n=7'"),
  ]);
  for (const c of ["printf '%d\\n' 5", "printf '%s: %d\\n' \"$name\" 5", "printf '%s\\n' 'n=7'", 'printf "%d items\\n" 3']) allow(P(c));
});
test('names the shell supplies as text (_ REPLY BASH_REMATCH), an array element and a ${i:=v} default hold text an arithmetic can evaluate', () => {
  denyEach([
    P("true; : 'n=7'; : $((_))"), P("read <<< 'n=7'; : $((REPLY))"), P("[[ 'n=7' =~ (.*) ]]; : $((BASH_REMATCH))"), P("true; : ${i:='n=7'}; : $((i))"), P("a=(0 'n=7'); : $(( a[1] ))"),
    P("a[1]='n=7'; : $(( a[1] ))"), P("status='n=7'; : $((status))"), P("_=5; : $((_))"), P("REPLY=5; read <<< 'n=7'; : $((REPLY))"), P("b[1]=5 c[2]='n=7'; : $(( c[2] ))"),
  ]);
  deny('bash run.sh', { 'run.sh': 'n=2; : $((BASH_SOURCE)); bash s$n.sh\n', ...SPEC });
});
test('one command assigning a name twice, a nameref and a value the evidence rule does not take as a number', () => {
  denyEach([
    P("i='n=7' j=$((i)) i=5; : $((i))"), P("i=3; declare -n r=i; r='n=7'; : $((i))"), P("i='$((1))'; : $((i))"), P('i="\\$((1))"; : $((i))'), P('i=x$((1)); : $((i))'),
    'n=2; declare -n r=n; r=7; bash s$n.sh', // (also live on main in the git guard)
  ]);
  for (const c of [P('i=$((1)); : $((i))'), P('i=3; : $((i))'), P('true; rc=$?; [[ $rc -eq 0 ]] && echo y'), P('i=${#n}; : $((i))')]) allow(c);
});
test('a quote, backtick or backslash inside a $[ ], subscript or offset body is read as written, not as the blanked text', () => {
  denyEach([P(': $[ "n=7" ]'), P('a["n=7"]=x'), P("i='n=7'; : $[ \"i\" ]"), P("i='n=7'; a[\"i\"]=x"), P("i='n=7'; : $[ i\\\nj ]")]);
});
test('a read in a frame that evals, traps or sources code may name text another command set: every read is unproven', () => {
  denyEach([P("eval '(( n += 5 ))'"), P("i='n=7'; eval ': $((i))'"), P(`eval "i='n=7'"; : $((i))`)]);
  const r = files(P("trap '(( n += 5 ))' DEBUG; true"), fakeFs(PROJ, SPEC));
  assert.equal(r.decision, 'deny', 'files allowed a trap whose text assigns the name');
  deny(P('source env.sh; : $((i))'), { 'env.sh': "i='n=7'\n", ...SPEC });
  allow(P(': $((i))'));
  deny('export n=2; source calc.sh; bash s$n.sh', { 'calc.sh': "n=2; i='n=7'; : $((i))\n", ...SPEC });
  deny('export n=2; source outer.sh; bash s$n.sh', { 'outer.sh': '. calc.sh\n', 'calc.sh': "i='n=7'; : $((i))\n", ...SPEC });
  deny("export n=2; i='n=7'; source calc.sh; bash s$n.sh", { 'calc.sh': ': $((i))\n', ...SPEC });
  deny("export n=2; a=(0 'n=7'); source calc.sh; bash s$n.sh", { 'calc.sh': 'a=5; : $(( a[1] ))\n', ...SPEC });
  allow("export n=2; i='n=7'; bash calc.sh; bash s$n.sh", { 'calc.sh': ': $((i))\n', ...SPEC }); // (a child shell cannot change the caller)
  // (a `dynamic` arithmetic in the caller reaches a judged use in a SECOND sourced file: git denies `source …; $n` for another reason, so the use sits in the file)
  deny("export n=2; i='n=7'; : $((i)); source run.sh", { 'run.sh': 'bash s$n.sh\n', ...SPEC });
  deny("export n=2; i='n=7'; : $((i)); bash run.sh", { 'run.sh': 'bash s$n.sh\n', ...SPEC });
});
test('a read in a nested script sees the value the caller gave the name (or lost): a certain assignment in the leading run replaces it, nothing else does', () => {
  const run = (body) => ({ 'run.sh': body, ...SPEC });
  deny("export n=2 i='n=7'; bash run.sh", run('[ -f x ] && i=3; : $((i)); bash s$n.sh\n'));
  deny("export n=2 i='n=7'; bash run.sh", run('i=3 true; : $((i)); bash s$n.sh\n'));
  deny("export n=2 i='n=7'; bash run.sh", run('i[2]=3; : $((i)); bash s$n.sh\n'));
  deny("export n=2 i='n=7'; bash run.sh", run(': $((i)); i=3; bash s$n.sh\n'));
  deny("export n=2; read i <<< 'n=7'; bash run.sh", run(': $((i)); bash s$n.sh\n'));
  allow("export n=2 i='n=7'; bash run.sh", run('i=3; : $((i)); bash s$n.sh\n'));
  allow('export n=2 i=4; bash run.sh', run(': $((i)); bash s$n.sh\n'));
  const r = files('bash run.sh', fakeFs(PROJ, run(': $((i)); bash s$n.sh\n')), { env: { i: 'n=7', n: '2' } });
  assert.equal(r.decision, 'deny', 'files allowed an arithmetic that reads a name the environment gave text');
});
test('a subscript or offset longer than the guard reads is refused, one it reads in full is not (199 / 200 / 201 characters)', () => {
  const sub = (len, i) => `n=2; ${i}; echo \${a[${'0'.repeat(len - 2)}+i]}; bash s$n.sh`;
  const off = (len, i) => `n=2; ${i}; x=abc; echo \${x:${'0'.repeat(len - 2)}+i}; bash s$n.sh`;
  for (const make of [sub, off]) {
    deny(make(199, "i='n=7'"));
    deny(make(200, "i='n=7'")); // (the read at the end is reached)
    deny(make(201, 'i=3')); // (cut: not read in full, whatever i holds)
    allow(make(200, 'i=3'));
  }
});
test('a substring subscript past 64 characters is refused (63 / 64 allowed), as is an expansion that joins an identifier', () => {
  const ix = (len) => '1+'.repeat((len - 1) / 2) + '1';
  deny(`n=2; echo \${a[${ix(65)}]:1}; bash s$n.sh`);
  allow(`n=2; echo \${a[${ix(63)}]:1}; bash s$n.sh`);
  allow(`n=2; echo \${a[${ix(61)}]:1}; bash s$n.sh`);
  deny(P('s=abc; : $(( a${#s} ))'));
  allow(P('s=abc; : $(( ${#s} + 1 ))'));
});
test('everyday arithmetic: counters, loops, RANDOM, SECONDS, an array index, a [[ -gt ]] operand and printf of a number stay allowed, and the proof says dynamic === false', () => {
  for (const c of [
    'for ((i=0;i<3;i++)); do echo $i; done; n=2; bash s$n.sh', 'n=0; n=$((n+1)); m=2; bash s$m.sh', 'sleep $((RANDOM%3)); n=2; bash s$n.sh', 'n=2; a=(1 2 3); i=1; echo ${a[i]}; bash s$n.sh',
    'n=3; [[ n -gt 2 ]] && echo big; bash s2.sh', 'n=2; let n=3; bash s2.sh', 'x=$((16#ff)); n=2; bash s$n.sh', 'n=2; echo $(( $# + 1 )); bash s$n.sh', 'n=2; i=${#n}; : $((i)); bash s$n.sh',
    't0=$SECONDS; n=2; echo $((SECONDS - t0)); bash s$n.sh',
  ]) {
    allow(c);
    assert.equal(arithAssignedNames(c, simpleCommands(c, {})).dynamic, false, c);
  }
  allow('n=3; echo $((n+1)); bash s2.sh');
  assert.equal(git('n=3; echo $((n+1)); git checkout -b feat/x$n', fakeFs(GIT_ROOT, SPEC)).decision, 'allow');
});
test('the proof depends on the frame it runs in: one parsed line, two outer frames, two answers', () => {
  const t = ': $((i))';
  const cmds = simpleCommands(t, {});
  assert.equal(arithAssignedNames(t, cmds, { vars: { i: '5' }, unknown: new Set(), env: {} }).dynamic, false);
  assert.equal(arithAssignedNames(t, cmds, { vars: { i: 'n=7' }, unknown: new Set(), env: {} }).dynamic, true);
  assert.equal(arithAssignedNames(t, cmds, { vars: {}, unknown: new Set(['i']), env: {} }).dynamic, true);
  assert.equal(arithAssignedNames(t, cmds, null).dynamic, false);
});
test('the names a clean bash or zsh defines at start are all listed as text or as integers (a name missing from both would read as an unset number: 0), and a refusal names the arithmetic read', () => {
  // (compared with the live shells when they exist; the lists were taken from these dumps plus bash(1) "Shell Variables" and zshparam(1) "Parameters set by the shell")
  for (const [bin, args] of [['/bin/bash', ['--norc', '--noprofile', '-c', 'compgen -v']], ['/bin/zsh', ['-f', '-c', 'print -rl -- ${(k)parameters}']]]) {
    let out;
    try { out = execFileSync(bin, args, { env: {}, encoding: 'utf8' }); } catch { continue; } // (no such shell on this machine)
    for (const k of out.split('\n').filter((x) => /^[A-Za-z_]\w*$/.test(x))) {
      assert.ok(SHELL_SUPPLIED_TEXT.has(k) || SHELL_SUPPLIED_NUMBERS.has(k) || /^(?:BASH|ZSH_|COMP_|READLINE_|PROMPT)/.test(k), `${bin} defines ${k}: add it to SHELL_SUPPLIED_TEXT or SHELL_SUPPLIED_NUMBERS`);
    }
  }
  const r = git(P("i='n=7'; : $((i))"), fakeFs(GIT_ROOT, SPEC));
  assert.match(r.reason, /an arithmetic reads `i`, whose value is not a plain number here/, r.reason);
});
test('a dynamic body does not make unsure a name only that body expands, but the poison still reaches a later use; a status the environment gave as text is read as text; a certain array literal replaces an array of text', () => {
  // (the shell expands `$pid` inside the body before it evaluates the body: `echo "$(( $(ps -o rss= -p $pid)/1024 ))"` alone stays allowed, as on main)
  allow('echo "$(( $(ps -o rss= -p $pid)/1024 ))MB"');
  deny('n=2; echo "$(( $(ps -o rss= -p $pid)/1024 ))"; bash s$n.sh'); // (what main does for a `$(cat f)` body: the text evaluated can assign n)
  deny('n=2; echo "$(( $(ps -o rss= -p $pid)/1024 ))"; echo $pid > out/$pid.txt');
  const r = files('n=2; : $((status)); bash s$n.sh', fakeFs(PROJ, SPEC), { env: { status: 'n=7' } });
  assert.equal(r.decision, 'deny', 'files allowed an arithmetic that reads a status the environment gave as text');
  const cmds = simpleCommands('a=(0 1); a=5; : $(( a[1] ))', {});
  const bad = { vars: { a: "(0 n=7)" }, unknown: new Set(), env: {} };
  assert.equal(arithAssignedNames('a=(0 1); a=5; : $(( a[1] ))', cmds, bad).dynamic, false, 'a certain array literal in the leading run replaced the incoming array');
  const cmds2 = simpleCommands('a=5; : $(( a[1] ))', {});
  assert.equal(arithAssignedNames('a=5; : $(( a[1] ))', cmds2, bad).dynamic, true, 'a certain scalar replaces element 0 only');
});

// ---- review round 1 (#817): over-refusals and bypasses of the first build ---------------------------------------------------------------------------------------------------------
const SPEC2 = { ...SPEC, 'list.sh': 'ok' };
test('R1-B1: an array of numbers ending in a text word is read in linear time (the integer-array test backtracked exponentially)', () => {
  const t = 'ids=(1700000001 1700000002 1700000003 1700000004 latest); echo ${ids[@]}';
  const t0 = Date.now();
  arithAssignedNames(t, simpleCommands(t, {}));
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
test('R1-B2 / R1-F1 / R1-F2: a name used outside the one unproven body (quoted, or with another body or binder on the line) stays unknown', () => {
  denyEach([
    'n=2; echo "$(( $(ps -o rss= -p $pid)/1024 ))"; bash s"$pid".sh', // (R1-B2: a later double-quoted use)
    'n=2; echo "$(( $(ps -o rss= -p $pid)/1024 ))"; echo ${a[d]}; echo $pid > out/$pid.txt', // (R1-F2: a one-letter body elsewhere cut `pid` to `pi`)
    'read "$K" < cfg; echo "$(( $(wc -c < "$S") / 1024 ))"; bash "$S"', // (R1-F1: a run-time-named binder is a cause of its own)
  ]);
});
test('R1-B3: a child script whose arithmetic is dynamic does not make the caller\'s names unknown', () => {
  const r = git('ref=HEAD; read -r answer; bash calc.sh; git show "$ref"', fakeFs(GIT_ROOT, { 'calc.sh': ': $(( $(wc -l < data) + 1 ))\n', ...SPEC }));
  assert.equal(r.decision, 'allow', r.reason);
});
test('R1-B4 / R1-B6: printf of a number to a redirect, a proven $name argument, and a brace list that shifts the arguments', () => {
  allow('out=out.txt; printf \'%d\\n\' 42 > "$out"; bash s2.sh', SPEC2);
  allow('count=3; out=list.sh; printf \'%d\' $count; bash "$out"', SPEC2);
  deny(P("total=queued; printf '%s %d\\n' {prefix,total}"));
  deny(P("total=queued; printf '%d' $total"));
});
test('R1-B5: a copy of a shell-supplied number holds the text the line bound that name to', () => {
  deny(P('status=queued; i=$status; : $((i))'));
  allow(P('t0=$SECONDS; : $((SECONDS - t0))'));
});
test('R1-B7 / R1-B8 / R1-B9 / R1-F4: program text in quotes, a nested $(( )), a hex literal and a `.` operand are no assignment, text or runner', () => {
  allow(P("i=1; python3 -c 'i=0; i+=1'; echo \"$((i))\" > out.txt"));
  allow('out=s2.sh; : $(( 1 + $((2 + 3)) )); bash "$out"', SPEC2);
  allow(P('i=1; a=(1 2 3); echo ${a[$((i+1))]}'));
  allow(P('mask=0xff; echo "$((mask & 15))" > out.txt'));
  allow(P('i=1; command grep -r foo . ; echo $((i+1))'));
});
test('R1-F3: the text of a trap or eval written out is read with the caller\'s bindings; a source, or text built at run time, keeps every read unproven', () => {
  allow('OUT=dist; trap \'echo failed\' ERR; count=0; for f in src/*; do count=$((count+1)); done; echo "$count" > "$OUT/count.txt"');
  denyEach([P("i='n=7'; trap ': $((i))' DEBUG"), P("i='n=7'; eval ': $((i))'"), P('i=3; eval "$code"; : $((i))')]);
});
test('R2-F1 / R2-B1 / R2-B2: a length expansion is one number for printf, an unquoted $name that may be empty shifts the arguments, literal eval text that rebinds a number loses the proof', () => {
  allow('ref=HEAD; files=(a b c); printf \'%d files\' ${#files[@]}; git show $ref');
  allow('ref=HEAD; files=(a b c); printf \'%d files\' "${#files[@]}"; git show $ref');
  deny(P("label=''; value='count+1'; printf '%s %d\\n' $label 10 value"));
  const ev = "i=1; eval 'i=other'; : $((i))"; // (the guards' own eval handling refuses the line whole, so the proof is asserted directly)
  assert.equal(arithAssignedNames(ev, simpleCommands(ev, {})).dynamic, true, 'literal eval text that rebinds i makes the read of i unproven');
});
