// Child process for test/helpers/db-refs-owner.mjs: one `pipeline db-refs` call run as the owner would run it (own terminal), against an EXPLICIT disposable home.
// argv[2] = JSON { home, args }. Prints { exitCode, output } as JSON. It refuses to run when `home` is not under the OS temp folder, so a mistake in a test
// can never write the account's real registry (this entry deliberately does not go through bin/pipeline.mjs, which passes no `home`).
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { run } from '../../pipeline/commands/db-refs.mjs';

const { home, args } = JSON.parse(process.argv[2]);
const tmp = realpathSync.native(tmpdir());
let real;
try { real = realpathSync.native(home); } catch { real = home; }
if (typeof home !== 'string' || !(real === tmp || real.startsWith(tmp + sep)) || real === tmp) {
  console.error(`db-refs-owner-child: refusing a home outside ${tmp}: ${home}`);
  process.exit(3);
}
const r = await run(args, { home });
process.stdout.write(JSON.stringify({ exitCode: r.exitCode, output: r.output }));
