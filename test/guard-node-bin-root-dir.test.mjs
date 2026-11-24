// Why (#352): `false && <dir>/serve.sh`, a zsh script ending in `exec npm start` (start = `next start`), was refused: "the script .../node_modules/.bin/next would run:
// the script ~/.zshenv is built from pieces". node_modules/.bin/next is a `#!/usr/bin/env node` program; binIsProgram turns away from "program" a shebang whose interpreter path lies INSIDE the
// project (the project may supply it). The guard also judges the bin as run from every directory the line may be in, and when that directory is the file system root, every path (/usr/bin/env too) is
// "inside" it, so the program was opened as a shell script and its JavaScript read as shell (every `=>` and `>=` a redirection), which pulled in the zsh startup file judgment.
// Rule held here: the file system root is never "the project" for a shebang path unless it is the only root there is (a bin that really lives under /). A shebang that names a file inside the real project is still opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { binIsProgram, binSite } from '../pipeline/hooks/lib/package-scripts.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const BAD = { git: `git ${PUSH} origin ${MAIN}`, files: `cp a ~/${CL}/settings.json` };

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
const run = (guard, cmd, files, o = {}) => {
  const root = guard === 'git' ? GIT_ROOT : PROJ;
  const fs = fakeFs(root, files);
  const cwd = resolve(root);
  return guard === 'git'
    ? evaluateGitCommand(cmd, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...o })
    : evaluateBashForFiles(cmd, { home: '/home/u', env: {}, platform: PLATFORM, realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...o });
};
const GUARDS = ['git', 'files'];

// the shapes of next's own text that read as shell redirections: `>=` inside a string, arrow functions, a template literal
const NEXT_JS = () => `#!/usr/bin/env node
"use strict";
if (!_semver.default.satisfies(process.versions.node, "^18.18.0 || ^19.8.0 || >= 20.0.0", {
    includePrerelease: true
})) {
    console.error(\`You are using Node.js \${process.versions.node}. Node.js version "\${"^18.18.0 || >= 20.0.0"}" is required.\`);
    process.exit(1);
}
program.hook('preAction', (event)=>{ return event; });
program.configureHelp({ formatHelp: (cmd, helper)=>(0, _x.format)(cmd, helper), subcommandTerm: (cmd)=>\`\${cmd.name()} \${cmd.usage()}\` });
program.command('start').action((options, directory)=>import('../cli/next-start.js').then((mod)=>mod.nextStart(options, directory)));
`;
// serve.sh as the real one is shaped: a zsh script that moves to the parent of its own directory and runs the package's start script. (R32 redesign: the real one prints with zsh print, which is not
// judged read-only (main's behaviour: it is refused after a cd known only at run time); this fixture says echo so the test stays about the node program, not about print)
const SERVE = '#!/bin/zsh\n# starts the app\nexport PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"\ncd "${0:A:h:h}" || exit 1\necho "starting $(date \'+%F\')"\nexec npm start\n';
const project = (guard, scripts, bin) => ({
  'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts }),
  'scripts/serve.sh': SERVE,
  'node_modules/next/dist/bin/next': bin(guard),
  'node_modules/.bin/next': bin(guard),
});
const decide = (guard, cmd, scripts, bin) => run(guard, cmd, project(guard, scripts, bin)).decision;

test('binSite: the file system root is not the project for a shebang path, unless it is the only root there is', () => {
  const run0 = binSite('/home/u/proj/node_modules/.bin/next', '/', () => false, path.posix);
  assert.equal(run0.inside('/usr/bin/env'), false, 'a run directory of / does not make /usr/bin/env part of the project');
  assert.equal(run0.inside('/home/u/proj/vendor/node'), true, 'the bin\'s own package directory still is');
  const atRoot = binSite('/node_modules/.bin/next', '/', () => false, path.posix);
  assert.equal(atRoot.inside('/usr/bin/env'), true, 'a project that really lives at / keeps the strict reading');
  assert.equal(binIsProgram('#!/usr/bin/env node\n', run0), true, 'env node is a program from a run directory of /');
  assert.equal(binIsProgram('#!/usr/bin/env node\n', atRoot), false, 'and still opened for a project at /');
});

test('#352: `false && serve.sh` (exec npm start -> next start, next a node program) is allowed by both guards', () => {
  for (const scripts of [{ start: 'next start' }, { start: 'NODE_OPTIONS=--max-old-space-size=2048 next start -p 4317 -H 127.0.0.1' }, { build: 'next build' }]) {
    const script = Object.keys(scripts)[0];
    const sh = SERVE.replace('npm start', `npm run ${script}`);
    for (const g of GUARDS) {
      const files = { ...project(g, scripts, NEXT_JS), 'scripts/serve.sh': sh };
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g} ${JSON.stringify(scripts)}: ${r.reason}`);
    }
  }
});

test('#352 trade-off (R32 redesign, R33-F1): the same serve.sh printing with zsh print instead of echo is refused by the files guard', () => {
  // zsh print is not judged read-only (main's behaviour) after a cd known only at run time; the real
  // serve-wallboard.sh switches to echo. Pinned so the trade-off is visible and cannot drift unnoticed.
  const sh = SERVE.replace('echo "starting', 'print "starting');
  assert.notEqual(sh, SERVE, 'the fixture still holds the echo line this test rewrites');
  const r = run('files', `false && ${PROJ}/scripts/serve.sh`, { ...project('files', { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': sh });
  assert.equal(r.decision, 'deny', `print shape: ${r.reason}`);
});

test('#352 negative controls: a shell script in .bin/next, or a script that writes the zsh startup file in pieces, is still refused', () => {
  const sh = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const g of GUARDS) {
    const r = run(g, `npm start`, project(g, { start: 'next start' }, sh));
    assert.equal(r.decision, 'deny', `${g} shell bin: ${r.reason}`);
  }
  // a line that puts ~/.zshenv together from pieces (one of them unknown) before the zsh script runs it
  const files = { ...project('files', { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': '#!/bin/zsh\nexec npm start\n' };
  for (const cmd of [`printf 'a' > ~/.zshenv; printf "$(cat /x)" >> ~/.zshenv; ${PROJ}/scripts/serve.sh`, `printf 'a' > ~/.zshenv; printf "$X" >> ~/.zshenv; zsh ${PROJ}/scripts/serve.sh`]) {
    const r = run('files', cmd, files);
    assert.equal(r.decision, 'deny', `zshenv in pieces: ${cmd} -> ${r.reason}`);
  }
});

test('#352 negative control: a node program that names a protected path in a write is still refused', () => {
  const prog = () => `#!/usr/bin/env node\nrequire('fs').writeFileSync(require('os').homedir() + '/${CL}/settings.json', 'x');\n`;
  const files = { ...project('files', { start: 'next start' }, NEXT_JS), 'tools/prog.mjs': prog() };
  const r = run('files', `${PROJ}/tools/prog.mjs`, files);
  assert.equal(r.decision, 'deny', r.reason);
  assert.equal(run('files', `${PROJ}/scripts/serve.sh`, { ...files, 'scripts/serve.sh': `#!/bin/sh\nexec ${PROJ}/tools/prog.mjs\n` }).decision, 'deny', 'through a script as well');
});

// Why (#352 follow-up): a zsh script that cd's to "${0:A:h:h}" left the git guard without a directory, and `exec npm start` after it was judged only when the line mentioned a guarded operation, so a package script
// running a bin that pushes was allowed (`false && serve.sh`). In a script file the lost directory is judged as the script's own directory and each one above it, as the files guard resolves $0 itself.
test('#352 follow-up: a cd to the script\'s own parent does not hide the package script (bin that pushes / writes a protected file)', () => {
  const cds = ['cd "${0:A:h:h}" || exit 1', 'cd "${0:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1', 'cd "$SOME_DIR" || exit 1'];
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const cd of cds) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'evil' }, bad), 'node_modules/.bin/evil': bad(g), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec npm start\n` };
      delete files['node_modules/.bin/next'];
      delete files['node_modules/next/dist/bin/next'];
      for (const line of [`false && ${root}/scripts/serve.sh`, `${root}/scripts/serve.sh`]) {
        const r = run(g, line, files);
        assert.equal(r.decision, 'deny', `${g}: ${cd}: ${line} -> ${r.reason}`);
      }
    }
  }
});

test('#352 follow-up: the clean next chain behind the same cd is still allowed by both guards', () => {
  for (const cd of ['cd "${0:A:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1']) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec npm start\n` };
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g}: ${cd} -> ${r.reason}`);
    }
  }
});

// Why (#352 follow-up 2): the same lost directory hid a bin run by a package runner (`exec npx evil` after the cd): the runner's bin lookup got no directory at all.
const RUNNERS = ['npx evil', 'npm exec evil', 'pnpm exec evil', 'yarn exec evil', 'bunx evil'];
const RUNNERS_CLEAN = ['npx next start', 'npm exec next', 'pnpm exec next start'];
test('#352 follow-up: a runner run after a cd to the script\'s parent still reaches the bin (pushes / writes a protected file)', () => {
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const tail of RUNNERS) {
    for (const cd of ['cd "${0:A:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1']) {
      for (const g of GUARDS) {
        const root = g === 'git' ? GIT_ROOT : PROJ;
        const files = { ...project(g, { start: 'evil' }, bad), 'node_modules/.bin/evil': bad(g), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec ${tail}\n` };
        const r = run(g, `${root}/scripts/serve.sh`, files);
        assert.equal(r.decision, 'deny', `${g}: ${cd}; exec ${tail} -> ${r.reason}`);
      }
    }
  }
});

test('#352 follow-up: the clean runner chain (npx next start, npm exec next) behind the same cd is still allowed by both guards', () => {
  for (const tail of RUNNERS_CLEAN) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': `#!/bin/zsh\ncd "\${0:A:h:h}" || exit 1\nexec ${tail}\n` };
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g}: exec ${tail} -> ${r.reason}`);
    }
  }
});

// Why (#352 R1-B2): binSite dropped the bin's OWN package root when that is `/` (a bin /node_modules/.bin/tool run from /sub), so a shebang `#!/vendor/node` was not "inside the project" and the program was not opened.
// Only a guessed run directory that is `/` is dropped; the package root of the bin is always kept.
test('#352 R1-B2: binSite keeps the bin\'s own package root when it is /, run from a subdirectory', () => {
  const s = binSite('/node_modules/.bin/tool', '/sub', () => false, path.posix);
  assert.equal(s.inside('/vendor/node'), true, 'a path under the bin\'s package root (/) is inside the project');
  const t = binSite('/home/u/proj/node_modules/.bin/tool', '/', () => false, path.posix);
  assert.equal(t.inside('/vendor/node'), false, 'a guessed run directory of / is still dropped');
});

test('#352 R1-B2: a root-level bin run from a subdirectory whose shebang names a program in the project is opened by both guards', () => {
  for (const g of GUARDS) {
    const root = '/sub';
    const files = { '/sub/package.json': '{}', '/node_modules/.bin/tool': '#!/vendor/node\necho ok\n', '/vendor/node': `#!/bin/sh\n${BAD[g]}\n` };
    const fs = fakeFs(root, files);
    const cwd = resolve(root);
    const o = { home: '/home/u', realpath: (p) => p, cwd, ...fs };
    const r = g === 'git'
      ? evaluateGitCommand('npx tool', { currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...o })
      : evaluateBashForFiles('npx tool', { env: {}, platform: PLATFORM, existsSync: fs.pathExists, ...o });
    assert.equal(r.decision, 'deny', `${g}: ${r.reason}`);
  }
});

// Why (#352 R1-B1): the per-ancestor package-script probes shared branch state, so a `git switch` in a script that may never run was kept as the certain branch and a later bare push was judged against it.
const PUSH_BARE = 'git ' + PUSH;
test('#352 R1-B1: a branch switched in a package script that may not run (lost cd) does not make a later push look safe', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git switch agent/safe' } }),
    'scripts/start.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
    'release.sh': `#!/bin/bash\n${PUSH_BARE}\n`,
  };
  const r = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, files, { currentBranch: () => MAIN });
  assert.equal(r.decision, 'deny', r.reason);
  // an alias defined by the speculative script is just as uncertain
  const al = { ...files, 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git config alias.ship "' + PUSH + ' origin agent/x"' } }), 'release.sh': `#!/bin/bash\ngit ship\n` };
  const r2 = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, al, { currentBranch: () => MAIN });
  assert.equal(r2.decision, 'deny', 'alias: ' + r2.reason);
});

test('#352 R1-B1 control: the same switch run in a directory that is known (no lost cd) is still the certain branch', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git switch agent/safe' } }),
    'scripts/start.sh': '#!/bin/bash\nnpm start\n',
    'release.sh': `#!/bin/bash\n${PUSH_BARE}\n`,
  };
  // #352 R38-F2: a script's change never carries over to its caller (owner decision): the bare push in the next script no longer rests on the switch; one that names the branch does not need it
  const r = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, files, { currentBranch: () => MAIN });
  assert.equal(r.decision, 'deny', 'allowed');
  const named = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, { ...files, 'release.sh': `#!/bin/bash\n${PUSH_BARE} origin agent/safe\n` }, { currentBranch: () => MAIN });
  assert.equal(named.decision, 'allow', named.reason);
});

// Why (#352 R1-F1): selfDirs walked the script path as named; a link to the script (`cd "${0:A:h:h}"` resolves it) was not covered.
test('#352 R1-F1: a script run through a link in another directory is refused like the real path', () => {
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  const files = { ...project('git', { start: 'evil' }, bad), 'node_modules/.bin/evil': bad('git'), 'scripts/serve.sh': '#!/bin/zsh\ncd "${0:A:h:h}" || exit 1\nexec npm start\n', '/home/u/bin/serve': '#!/bin/zsh\ncd "${0:A:h:h}" || exit 1\nexec npm start\n' };
  // (Windows: the guard asks for D:\home\u\bin\serve; the link is named by its POSIX path)
  const linkReal = (p) => (String(p).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/') === '/home/u/bin/serve' ? `${GIT_ROOT}/scripts/serve.sh` : p);
  assert.equal(run('git', `${GIT_ROOT}/scripts/serve.sh`, files).decision, 'deny', 'real path');
  const r = run('git', '/home/u/bin/serve', files, { realpath: linkReal });
  assert.equal(r.decision, 'deny', r.reason);
});

// Why (#352 R1-F2): the same package.json reached from several ancestors was judged once per ancestor, spending the script allowance.
test('#352 R1-F2: a package.json reached from many ancestor directories is judged once', () => {
  const dirs = Array.from({ length: 12 }, (_, i) => `d${i}`).join('/');
  const names = Array.from({ length: 12 }, (_, i) => `b${i}`);
  const scripts = { start: names.map((n) => `cd "$SOME_DIR" && npm run ${n}`).join('; '), ...Object.fromEntries(names.map((n) => [n, 'echo built'])) };
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts }),
    [`${dirs}/serve.sh`]: '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
  };
  const r = run('git', `${GIT_ROOT}/${dirs}/serve.sh`, files);
  assert.equal(r.decision, 'allow', r.reason);
});

// Why (#352 R2-B1): an inner judgeAlternatives restored the alias map and kept the change only in aliasUnsure; the outer one then reset aliasUnsure to its own start, so the uncertainty was lost.
test('#352 R2-B1: an alias defined by a script nested in a speculative script is still unsure afterwards', () => {
  const mk = (setup, release = 'git ship') => ({
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'cd "$SOME_DIR" || exit 1; npm run setup', setup } }),
    'start.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
    'release.sh': `#!/bin/bash\n${release}\n`,
  });
  const line = `bash ${GIT_ROOT}/start.sh; bash ${GIT_ROOT}/release.sh`;
  const r = run('git', line, mk('git config alias.ship "' + PUSH + ' origin ' + MAIN + '"'));
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /the git alias "ship" may have been \(re\)defined/, r.reason); // (the uncertainty, not the unknown directory or another refusal)
  // allow twins: a harmless alias under another name, no alias, and a release that does not use the alias are not refused
  for (const [what, files] of [['other alias', mk('git config alias.st status')], ['no alias', mk('echo setup')], ['not the alias', mk('git config alias.ship "' + PUSH + ' origin ' + MAIN + '"', 'git status')]]) {
    const ok = run('git', line, files);
    assert.equal(ok.decision, 'allow', `${what}: ${ok.reason}`);
  }
});

// Why (#352 R2-F1): runs of one workspace plan share state (an alias, a config change), and the plan's ORDER depends on the candidate directory; skipping a run already judged for another directory
// skipped the order npm really uses (a, then b), so `git ship main` was never judged after the alias existed.
test('#352 R2-F1: a workspace plan whose order differs by candidate directory is judged in every order', () => {
  const mk = (a, b) => ({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs/a', 'pkgs/b'] }),
    'pkgs/a/package.json': JSON.stringify({ name: 'a', scripts: { go: a } }),
    'pkgs/b/package.json': JSON.stringify({ name: 'b', scripts: { go: b } }),
    'pkgs/b/run.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm run go --workspaces\n',
  });
  const line = `bash ${GIT_ROOT}/pkgs/b/run.sh`;
  const cfg = run('git', line, mk('git config push.default upstream', PUSH_BARE)); // (on a feature branch a bare push is unsafe only once push.default may point it at main)
  assert.equal(cfg.decision, 'deny', 'push.default: ' + cfg.reason);
  assert.match(cfg.reason, /changes upstream\/push configuration/, 'push.default: ' + cfg.reason);
  const al = run('git', line, mk('git config alias.ship "' + PUSH + ' origin"', `git ship ${MAIN}`), { currentBranch: () => MAIN });
  assert.equal(al.decision, 'deny', 'alias: ' + al.reason);
  // (#352 R38-F2: the alias run a defines is unknown for run b, so the refusal names that, not the push to main the known alias would have been; still only reached when run a is judged before run b)
  assert.match(al.reason, /pushing to main is blocked|the git alias "ship" may have been \(re\)defined/, 'alias: ' + al.reason);
  // allow twins: the same two workspace scripts with a harmless configuration / alias are not refused
  const cfgOk = run('git', line, mk('git config user.name x', PUSH_BARE));
  assert.equal(cfgOk.decision, 'allow', 'harmless config: ' + cfgOk.reason);
  // (#352 R38-F2: an alias a script defines is unknown for what runs after it, a harmless value included (owner decision: a script's change never carries over to its caller); a use of another name is the twin)
  const alOk = run('git', line, mk('git config alias.ship status', `git ship ${MAIN}`), { currentBranch: () => MAIN });
  assert.equal(alOk.decision, 'deny', 'harmless alias: allowed');
  const alOther = run('git', line, mk('git config alias.ship status', `git status`), { currentBranch: () => MAIN });
  assert.equal(alOther.decision, 'allow', 'harmless alias, not used: ' + alOther.reason);
});

// Why (#352 R3-F1): judgeReadings reset aliasUnsure for every reading and built its union from alias MAP differences only; judgeAlternatives (a lost cd in a script) restores the map and leaves only an unsure mark,
// so a mark made in a reading other than the last was wiped. The loop `for s in setup other` reads the script twice; the mark of the first reading (npm run setup) must survive the second (npm run other).
const LOOP_START = '#!/bin/bash\nfor s in setup other; do cd "$SOME_DIR" || exit 1; npm run $s; done\n';
const loopFiles = (setup, release) => ({
  'package.json': JSON.stringify({ name: 'x', scripts: { setup, other: 'echo hi' } }),
  'start.sh': LOOP_START,
  'release.sh': `#!/bin/bash\n${release}\n`,
});
const LOOP_LINE = `bash ${GIT_ROOT}/start.sh; bash ${GIT_ROOT}/release.sh`;
test('#352 R3-F1: an alias made in a reading of a loop that is not the last stays unsure (refused for the alias, not otherwise)', () => {
  const r = run('git', LOOP_LINE, loopFiles('git config alias.ship "' + PUSH + ' origin ' + MAIN + '"', 'git ship'));
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /may have been \(re\)defined/, r.reason);
  assert.match(r.reason, /"ship"/, r.reason);
});
test('#352 R3-F1 allow twins: a harmless alias under another name, or no alias at all, in the same loop is not refused', () => {
  const other = run('git', LOOP_LINE, loopFiles('git config alias.st status', 'git ship'));
  assert.equal(other.decision, 'allow', 'other alias: ' + other.reason);
  const none = run('git', LOOP_LINE, loopFiles('echo setup', 'git ship'));
  assert.equal(none.decision, 'allow', 'no alias: ' + none.reason);
  const plain = run('git', LOOP_LINE, loopFiles('git config alias.ship "' + PUSH + ' origin ' + MAIN + '"', 'git status'));
  assert.equal(plain.decision, 'allow', 'a command that is not the alias: ' + plain.reason);
});

// Why (#352 R4-F1): the readings of a `for` word are consecutive iterations of ONE shell, but judgeReadings judged each from the start state, so a command early in the body never saw what an earlier
// iteration left (an alias, a push.default, a branch). The body is judged once more from the union of what the readings left.
const bodyFiles = (body, setup) => ({
  'package.json': JSON.stringify({ name: 'x', scripts: { setup, other: 'echo hi' } }),
  'start.sh': `#!/bin/bash\nfor s in setup other; do ${body}; done\n`,
});
const BODY_LINE = `bash ${GIT_ROOT}/start.sh`;
const SHIP = 'git config alias.ship "' + PUSH + ' origin ' + MAIN + '"';
test('#352 R4-F1: an alias made by one iteration of a loop is judged against the command at the top of the next iteration', () => {
  for (const [what, body] of [['plain', 'git ship; npm run $s'], ['lost cd', 'git ship; cd "$SOME_DIR" || exit 1; npm run $s']]) {
    const r = run('git', BODY_LINE, bodyFiles(body, SHIP));
    assert.equal(r.decision, 'deny', `${what}: ${r.reason}`);
    assert.match(r.reason, /may have been \(re\)defined/, `${what}: ${r.reason}`);
    assert.match(r.reason, /"ship"/, `${what}: ${r.reason}`);
  }
});
test('#352 R4-F1: a push.default change by one iteration of a loop is judged against the bare push at the top of the next', () => {
  for (const [what, body] of [['plain', PUSH_BARE + '; npm run $s'], ['lost cd', PUSH_BARE + '; cd "$SOME_DIR" || exit 1; npm run $s']]) {
    const r = run('git', BODY_LINE, bodyFiles(body, 'git config push.default upstream'));
    assert.equal(r.decision, 'deny', `${what}: ${r.reason}`);
    assert.match(r.reason, /changes upstream\/push configuration/, `${what}: ${r.reason}`);
  }
});
test('#352 R4-F1: a branch change by one iteration of a loop is not taken as known at the top of the next', () => {
  const r = run('git', BODY_LINE, bodyFiles(PUSH_BARE + ' origin HEAD; npm run $s', 'git switch ' + MAIN), { currentBranch: () => 'agent/x' });
  assert.equal(r.decision, 'deny', r.reason);
});
test('#352 R4-F1 allow twins: a harmless alias, a harmless config, or a loop that changes no git state is not refused', () => {
  const alias = run('git', BODY_LINE, bodyFiles('git ship; npm run $s', 'git config alias.st status'));
  assert.equal(alias.decision, 'allow', 'other alias: ' + alias.reason);
  const harmless = run('git', BODY_LINE, bodyFiles('git status; npm run $s', 'git config alias.ship status'));
  assert.equal(harmless.decision, 'allow', 'an alias the body does not use: ' + harmless.reason);
  const cfg = run('git', BODY_LINE, bodyFiles(PUSH_BARE + '; npm run $s', 'git config user.name x'));
  assert.equal(cfg.decision, 'allow', 'harmless config: ' + cfg.reason);
  const none = run('git', BODY_LINE, bodyFiles('git ship; cd "$SOME_DIR" || exit 1; npm run $s', 'echo setup'));
  assert.equal(none.decision, 'allow', 'nothing changes git state: ' + none.reason);
});

// ---- an unknown run directory fails closed (narrowed refuse): #363, #366, #391 ---------------------------------------------------------------------------------------------
// Why: after a cd the guard cannot follow (`cd "$X"`, `cd "$(cmd)"`, a function / alias / trap / sourced file in front of it, a cd in a script file to a place named at run time) or with a --prefix only known at run time, a package
// run was judged only by "does the line's text mention a guarded word", so `cd "$X" && npm start` (a bad `start` in the working directory, or in a package folder next to it) was ALLOWED. The directory is now one of a few places near the
// line (every directory the line cds to, the script's own, the working directory, and each folder above, with the immediate sub-folders up to the repository root): each package found there is judged, and a bad script or bin refuses.
const pk = (scripts, extra = {}) => JSON.stringify({ name: 'p', scripts, ...extra });
const BADG = BAD.git;
const UNKNOWN_DIR = /the directory this runs in is unknown/;
// the refusal names the unknown-directory class AND the directory the bad package / bin was found in (a cap, a deadline or an internal error must not turn a row green)
const refuseIn = (cmd, files, where, o = {}) => {
  const r = run('git', cmd, files, o);
  assert.equal(r.decision, 'deny', `${cmd}: ${r.reason}`);
  assert.match(r.reason, UNKNOWN_DIR, `${cmd}: ${r.reason}`);
  assert.ok(r.reason.includes(`in ${GIT_ROOT}${where}, `), `${cmd}: names ${where || '/'}: ${r.reason}`);
  return r;
};
const allows = (cmd, files, o = {}) => { const r = run('git', cmd, files, o); assert.equal(r.decision, 'allow', `${cmd}: ${r.reason}`); return r; };
const bin = (text = BADG) => `#!/bin/sh\n${text}\n`;

test('#363 a cd the guard cannot follow does not hide a bad script or bin in the working directory or a package folder next to it', () => {
  refuseIn('cd "$X" && npm start', { 'package.json': pk({ start: BADG }) }, '');
  refuseIn('cd "$(some-cmd)" && npm start', { 'web/package.json': pk({ start: BADG }) }, '/web');
  refuseIn('cd "$X" && npx evil', { 'node_modules/.bin/evil': bin() }, '');
  refuseIn('cd "$X" && npx evil', { 'web/node_modules/.bin/evil': bin() }, '/web'); // (a folder with a bin and no package.json)
  refuseIn('cd "$X" && yarn evil', { 'web/node_modules/.bin/evil': bin() }, '/web');
  refuseIn('cd "$X" && npm exec -c evil', { 'package.json': pk({}), 'node_modules/.bin/evil': bin() }, '');
  refuseIn('cd "$X" && npm install', { 'web/package.json': pk({ postinstall: BADG }) }, '/web');
  refuseIn('cd "$X" && npm run a --prefix web', { 'web/package.json': pk({ a: BADG }) }, '');
  refuseIn(`cd "$X" && npm --prefix ${GIT_ROOT}/apps/web run a`, { 'apps/web/package.json': pk({ a: BADG }) }, '/apps/web'); // (an absolute prefix is judged once, at the prefix)
  // a literal tail behind a dynamic start: the folder is two levels down, so it is not a sub-folder of anything the line holds
  refuseIn('cd "$PWD/apps/web" && npm run a', { 'apps/web/package.json': pk({ a: BADG }) }, '/apps/web');
  refuseIn('cd "$(git rev-parse --show-toplevel)/apps/web" && npm run a', { 'apps/web/package.json': pk({ a: BADG }) }, '/apps/web');
});

test('#363 allow twins: harmless scripts and bins everywhere, and a script that is not the one run, are not refused', () => {
  allows('cd "$X" && npm start', { 'package.json': pk({ start: 'node server.js' }), 'web/package.json': pk({ start: 'next start' }) });
  allows('cd "$X" && npm test', { 'web/package.json': pk({ start: BADG, test: 'vitest' }) });
  allows('cd "$X" && npx evil', { 'web/node_modules/.bin/evil': bin('echo hi') });
  allows('cd "$X" && npm run "$S"', { 'web/package.json': pk({ a: BADG }) }); // (a script named at run time keeps today's rule: refused only when the line itself mentions a guarded word)
  // a sibling whose configuration would be refused but which has no script of that name is not what runs
  allows('cd "$X" && npm run a', { 'package.json': pk({ a: 'echo hi' }), 'web/package.json': pk({ b: 'echo hi' }), 'web/.npmrc': 'script-shell=/x/sh\n' });
  // a package.json that cannot be read is refused (owner: "bad or unreadable")
  refuseIn('cd "$X" && npm start', { 'web/package.json': null }, '/web');
});

test('#391 a cd after a function, alias, trap or sourced file the guard cannot follow, then the package run: the folder the line cds to is judged', () => {
  const sub = { 'sub/package.json': pk({ a: BADG }) };
  const deep = { 'apps/web/package.json': pk({ a: BADG }), 'env.sh': 'export A=1\n' };
  refuseIn('f() { npm run a; }; cd sub; f', sub, '/sub');
  refuseIn('f() { for x in 1; do npm run a; done; }; cd sub; f', sub, '/sub');
  refuseIn('f() { npm run a; }; cd apps/web; f', deep, '/apps/web');
  refuseIn('alias ll=ls; cd apps/web && npm run a', deep, '/apps/web');
  refuseIn('trap : EXIT; cd apps/web && npm run a', deep, '/apps/web');
  refuseIn('source ./env.sh; cd apps/web && npm run a', deep, '/apps/web');
  allows('f() { npm run a; }; cd apps/web; f', { 'apps/web/package.json': pk({ a: 'echo hi' }) });
});

test('#363 a directory the line held and then lost (a cd behind it, cd -, a subshell) is still where the package may be', () => {
  const web = { 'apps/web/package.json': pk({ start: BADG }) };
  refuseIn('cd apps && cd "$X" && npm start', web, '/apps/web'); // (the line was in apps; `cd "$X"` lost it)
  refuseIn(`cd ${GIT_ROOT}/apps && cd "$X"; (cd /tmp && cd "$Q"); npm start`, web, '/apps/web');
  refuseIn('cd apps/web && cd /usr && cd - && npm start', web, '/apps/web');
  // env -C with an absolute directory is a known directory for that command whatever the shell's is
  const r = run('git', `cd "$X" && env -C ${GIT_ROOT}/apps/web npm start`, web);
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /would run a blocked command/, r.reason);
});

// Why (F1): the script-file path already judged these after a lost cd (selfDirs); the new walk must keep every one of them refused, whatever the manager call.
test('#366 regression: in a script file, `cd "$X" || exit 1` then each package call still refuses (workspaces, -r, bin fallback, --prefix, explore, install hooks)', () => {
  const ws = { 'package.json': pk({}, { workspaces: ['packages/*'] }), 'packages/evil/package.json': pk({ a: BADG }) };
  const rows = [
    ['npm run a --workspaces', ws],
    ['pnpm -r run a', { 'package.json': pk({}), 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/evil/package.json': pk({ a: BADG }) }],
    ['yarn evil', { 'package.json': pk({}), 'node_modules/.bin/evil': bin() }],
    ['bun run evil', { 'package.json': pk({}), 'node_modules/.bin/evil': bin() }],
    ['npm --prefix web run a', { 'package.json': pk({}), 'web/package.json': pk({ a: BADG }) }],
    ['npm explore dep -- evil', { 'package.json': pk({}), 'node_modules/dep/package.json': pk({}), 'node_modules/.bin/evil': bin() }],
    ['npm install', { 'package.json': pk({ postinstall: BADG }) }],
  ];
  for (const [line, files] of rows) {
    const r = run('git', 'bash s.sh', { ...files, 's.sh': `cd "$X" || exit 1\n${line}\n` });
    assert.equal(r.decision, 'deny', `${line}: ${r.reason}`);
    assert.match(r.reason, /would run a blocked command/, `${line}: ${r.reason}`);
  }
});

// Why (#366): `cd "$(dirname "$0")/../web"` and `cd "$SOME_DIR"` in a script file go to a package folder BESIDE the script's own directories, which only the folders listed up to the repository root reach
// (the repository root is the nearest directory with a .git file or directory; with none, the working directory).
test('#366 a script that cds to a sibling package folder: the sibling\'s script is judged (.git file, .git directory, or no marker)', () => {
  for (const marker of [{}, { '.git': 'gitdir: ../x' }, { '.git/HEAD': 'ref: refs/heads/x' }]) {
    refuseIn('bash scripts/run.sh', { ...marker, 'scripts/run.sh': 'cd "$(dirname "$0")/../web" || exit 1\nexec npm start\n', 'web/package.json': pk({ start: BADG }) }, '/web');
    refuseIn('bash tools/a/run.sh', { ...marker, 'tools/a/run.sh': 'cd "$SOME_DIR" || exit 1\nnpm start\n', 'tools/b/package.json': pk({ start: BADG }) }, '/tools/b');
  }
  // the folders listed stop at the repository root: a package outside it is not near the script
  refuseIn('bash tools/a/run.sh', { 'tools/.git': 'x', 'tools/a/run.sh': 'cd "$SOME_DIR" || exit 1\nnpm start\n', 'tools/b/package.json': pk({ start: BADG }) }, '/tools/b');
  allows('bash tools/a/run.sh', { 'tools/a/.git': 'x', 'tools/a/run.sh': 'cd "$SOME_DIR" || exit 1\nnpm start\n', 'tools/b/package.json': pk({ start: BADG }) });
  allows('bash scripts/run.sh', { 'scripts/run.sh': 'cd "$(dirname "$0")/../web" || exit 1\nexec npm start\n', 'web/package.json': pk({ start: 'next start' }) });
});

test('a script that is run in between and cds elsewhere adds nothing to the caller\'s places', () => {
  // (nested.sh moves to apps; the caller's own `cd "$X"` is judged from the places the CALLER held: /work/repo, whose sub-folder apps holds no package, not apps/web)
  const files = { 'nested.sh': `cd ${GIT_ROOT}/apps\n`, 'apps/web/package.json': pk({ start: BADG }) };
  allows('bash nested.sh; cd "$X" && npm start', files);
  refuseIn(`cd ${GIT_ROOT}/apps; cd "$X" && npm start`, files, '/apps/web'); // (control: the caller's own cd is held)
});

// ---- the bounds: sub-directories listed, the listing counted once, the deadline, the number of places judged ---------------------------------------------------------
const wide = (n, extra = {}) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${String(i).padStart(4, '0')}/x`, ''])), ...extra });
test('a folder with more than 256 sub-directories cannot be listed: refused for the cap; 256 exactly, or 1000 files and 3 folders, is judged', () => {
  const r = run('git', 'cd "$X" && npm start', wide(257, { 'package.json': pk({ start: 'node server.js' }) }));
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /too many folders\/packages near \/work\/repo/, r.reason);
  allows('cd "$X" && npm start', wide(256, { 'package.json': pk({ start: 'node server.js' }) }));
  const files = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${i}.txt`, 'x']));
  allows('cd "$X" && npm start', { ...files, 'a/x': '', 'b/x': '', 'c/x': '', 'package.json': pk({ start: 'node server.js' }) }); // (files are not folders: only sub-directories count toward the bound)
});

test('the folders listed are counted once per evaluation: repeated package runs list nothing again', () => {
  const files = { 'package.json': pk({ a: 'echo hi' }), 'web/package.json': pk({ a: 'echo hi' }) };
  const count = (cmd) => { let n = 0; const fs = fakeFs(GIT_ROOT, files); allows(cmd, files, { readDir: (p) => { n++; return fs.readDir(p); } }); return n; };
  const once = count('cd "$X" && npm run a');
  assert.ok(once > 0, 'the folders were listed');
  assert.equal(count('cd "$X" && npm run a && npm run a && npm run a'), once, 'three runs list what one run lists');
});

test('a deadline that passes while the folders are listed refuses with the time reason, not a crash', () => {
  let t = 0;
  const files = { 'package.json': pk({ a: 'echo hi' }), 'web/package.json': pk({ a: 'echo hi' }) };
  const fs = fakeFs(GIT_ROOT, files);
  const r = run('git', 'cd "$X" && npm run a', files, { now: () => t, readDir: (p) => { t += 60_000; return fs.readDir(p); } });
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /took too long/, r.reason);
});

test('a place too many: more than 16 packages near the directory that hold the script named refuse for the cap (the policy, documented)', () => {
  const siblings = Object.fromEntries(Array.from({ length: 43 }, (_, i) => [`p${String(i).padStart(2, '0')}/package.json`, pk({ lint: 'echo l', test: 'echo t', build: 'echo b' })]));
  const r = run('git', 'cd "$X" && npm run lint && npm test && npm run build', siblings);
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /too many/, r.reason);
  allows('cd "$X" && npm run lint', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}/package.json`, pk({ lint: 'echo l' })])));
});

test('a home directory is never listed: a bad script in a folder of the home is not reached from a working directory that is the home', () => {
  allows('cd "$X" && npm start', { '/home/u/other/package.json': pk({ start: BADG }) }, { cwd: '/home/u' });
});

// Why (D4): the candidates are alternatives, so what one sibling's script changes (a package.json write, a config file it writes, a `command cd`) is not what the NEXT sibling sees; afterwards a real later command sees it as "may have changed".
test('order: a sibling whose script runs `npm pkg set` does not make the next sibling\'s own `npm run` look like a later command, in either listing order; a later real run still sees the mark', () => {
  const writer = pk({ a: 'npm pkg set x=1' });
  const caller = pk({ a: 'npm run c', c: 'echo hi' }); // (its `npm run c` is judged after the writer's `npm pkg set` only when the two are not kept apart)
  for (const [first, second] of [['a-writer', 'b-caller'], ['a-caller', 'b-writer']]) {
    const files = { [`${first}/package.json`]: first === 'a-writer' ? writer : caller, [`${second}/package.json`]: second === 'b-writer' ? writer : caller };
    allows('cd "$X" && npm run a', files);
    const later = run('git', 'cd "$X" && npm run a && npm run a', files);
    assert.equal(later.decision, 'deny', `${first}/${second}: ${later.reason}`);
    assert.match(later.reason, /changes package\.json or the package manager's configuration/, `${first}/${second}: ${later.reason}`);
  }
});
test('order: a config file one sibling writes for the whole user (~/.npmrc) is not read by the next sibling, in either listing order; a later real run does read it', () => {
  const writer = pk({ a: "echo 'x=1' > /home/u/.npmrc" });
  for (const [first, second] of [['a-writer', 'b-clean'], ['a-clean', 'b-writer']]) {
    const files = { [`${first}/package.json`]: first === 'a-writer' ? writer : pk({ a: 'echo hi' }), [`${second}/package.json`]: second === 'b-writer' ? writer : pk({ a: 'echo hi' }) };
    allows('cd "$X" && npm run a', files);
    const later = run('git', 'cd "$X" && npm run a && npm run a', files);
    assert.equal(later.decision, 'deny', `${first}/${second}: ${later.reason}`);
    assert.match(later.reason, /writes \/home\/u\/\.npmrc/, `${first}/${second}: ${later.reason}`);
  }
});
test('no leak: a sibling whose script is `command cd dist && ls` does not leave "a cd behind command may have moved the shell" for the line that ran the sibling', () => {
  allows('cd "$X" && npm run build', { 'package.json': pk({ build: 'echo hi' }), 'web/package.json': pk({ build: 'command cd dist && ls' }) });
});
