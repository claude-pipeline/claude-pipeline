// Child for test/owner-go-click-pending.test.mjs (#472): one process of a race. Every path comes in as an argument; nothing is read from the environment.
//   node click-race.mjs settle <libDir> <home> <barrierFile> <nowMs>
//   node click-race.mjs claim  <libDir> <home> <barrierFile> <nowMs> <repo> <pr> <k> <head>
// role `settle`: settlePendingClicks({ home, now }) once the barrier file exists. Prints `ready` as soon as it is loaded, then one JSON line { outcomes, problems }.
// role `claim`: an extra-round claimer. Prints `ready` as soon as it is loaded, reads the open grants of (repo, pr, k, head) and blocks INSIDE that filtering (the io.afterSpentCheck seam, after the first
// grant it keeps) until the barrier file exists, printing `mid` when it gets there; then claims what it kept with a round ticket and prints the claim as one JSON line. Reads settle nothing (settle: false).
// It refuses (exit code 2, never 0) when the home it is given is the account's real one: a race must never write the owner's folder.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [role, libDir, home, barrier, nowArg, repo, prArg, kArg, head] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(libDir, name)).href);
const { accountHome } = await load('owner-go.mjs');
if (!home || path.resolve(home) === path.resolve(accountHome())) {
  console.error('click-race: refusing to run on the account home');
  process.exit(2);
}
if (role !== 'settle' && role !== 'claim') {
  console.error(`click-race: unknown role ${JSON.stringify(role)}`);
  process.exit(2);
}
const gate = new Int32Array(new SharedArrayBuffer(4));
const waitForBarrier = () => { while (!existsSync(barrier)) Atomics.wait(gate, 0, 0, 2); };
const nowMs = Number(nowArg);
if (role === 'settle') {
  const { settlePendingClicks } = await load('owner-go-click.mjs');
  console.log('ready');
  waitForBarrier();
  console.log(JSON.stringify(settlePendingClicks({ home, now: () => nowMs })));
} else {
  const { claimGrantMarkers, ownerGrantedRounds } = await load('owner-go.mjs');
  console.log('ready');
  let blocked = false;
  const io = { afterSpentCheck: () => { if (blocked) return; blocked = true; console.log('mid'); waitForBarrier(); } };
  const records = ownerGrantedRounds({ repo, pr: Number(prArg), k: Number(kArg), head, home, now: () => nowMs, settle: false, io });
  console.log(JSON.stringify(claimGrantMarkers(records, { repo, pr: Number(prArg), k: Number(kArg), head, checkout: null }, { home, now: () => nowMs, ticket: true })));
}
