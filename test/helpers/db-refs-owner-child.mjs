// Child process for test/helpers/db-refs-owner.mjs: one `pipeline db-refs` call run as the owner would run it (own terminal), against an EXPLICIT disposable home.
// argv[2] = JSON { home, args }. Prints { exitCode, output } as JSON. It refuses to run when `home` is not under the OS temp folder, so a mistake in a test
// can never write the account's real registry (this entry deliberately does not go through bin/pipeline.mjs, which passes no `home`).
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { run } from '../../pipeline/commands/db-refs.mjs';

const { home, args } = JSON.parse(process.argv[2]);
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
const r = await run(args, { home });
process.stdout.write(JSON.stringify({ exitCode: r.exitCode, output: r.output }));
