// Child for test/owner-go-click-pending.test.mjs (#472): one process of a race. Every path comes in as an argument; nothing is read from the environment.
//   node click-race.mjs <role> <libDir> <home> <barrierFile> <nowMs>
// role `settle`: settlePendingClicks({ home, now }) once the barrier file exists. Prints `ready` as soon as it is loaded, then one JSON line { outcomes, problems }.
// It refuses (exit code 2, never 0) when the home it is given is the account's real one: a race must never write the owner's folder.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [role, libDir, home, barrier, nowArg] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(libDir, name)).href);
const { accountHome } = await load('owner-go.mjs');
if (!home || path.resolve(home) === path.resolve(accountHome())) {
  console.error('click-race: refusing to run on the account home');
  process.exit(2);
}
if (role !== 'settle') {
  console.error(`click-race: unknown role ${JSON.stringify(role)}`);
  process.exit(2);
}
const { settlePendingClicks } = await load('owner-go-click.mjs');
console.log('ready');
const gate = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(barrier)) Atomics.wait(gate, 0, 0, 2);
const nowMs = Number(nowArg);
console.log(JSON.stringify(settlePendingClicks({ home, now: () => nowMs })));
