// Child process for test/helpers/db-refs-owner.mjs: one `pipeline db-refs` call run as the owner would run it (own terminal), against an EXPLICIT disposable home.
// argv[2] = JSON { home, args }. Prints { exitCode, output } as JSON. It refuses to run when `home` is not under the OS temp folder, so a mistake in a test
// can never write the account's real registry (this entry deliberately does not go through bin/pipeline.mjs, which passes no `home`).
import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dbRefsFile } from '../../pipeline/hooks/lib/db-refs.mjs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { run } from '../../pipeline/commands/db-refs.mjs';

const { home, args, during = null } = JSON.parse(process.argv[2]);
const tmp = realpathSync.native(tmpdir());
// The path as the writer will see it: normalised (a `..` after a missing folder cannot hide a way out), with the nearest existing parent resolved through symlinks; null when that fails.
const canonical = (p) => {
  if (typeof p !== 'string') return null;
  try {
    const abs = resolve(p);
    let at = abs;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    return resolve(realpathSync.native(at), abs.slice(at.length + 1));
  } catch { return null; }
};
const real = canonical(home);
if (real === null || real === tmp || !real.startsWith(tmp + sep)) {
  console.error(`db-refs-owner-child: refusing a home outside ${tmp}: ${home}`);
  process.exit(3);
}
// `during` (a test of a registry change made by a second terminal while the command works): the registry file is overwritten with this body the first time the command asks for the time
let fired = false;
// (never through a symlink: the write cannot leave the test home)
const now = () => {
  if (during !== null && !fired) {
    fired = true;
    const file = dbRefsFile(home);
    // (and never through a symlinked folder above it: its real parent must still be under the test home)
    const parent = canonical(dirname(file));
    if (parent === null || !parent.startsWith(real + sep)) throw new Error(`db-refs-owner-child: refusing to write to ${file}: its folder resolves outside the test home`);
    let linked = false;
    try { linked = lstatSync(file).isSymbolicLink(); } catch { /* absent: the write creates it */ }
    if (linked) throw new Error(`db-refs-owner-child: refusing to write through the symlink ${file}`);
    writeFileSync(file, `${JSON.stringify(during, null, 2)}\n`);
  }
  return Date.now();
};
const r = await run(args, during === null ? { home } : { home, now });
process.stdout.write(JSON.stringify({ exitCode: r.exitCode, output: r.output }));
