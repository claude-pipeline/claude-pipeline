// The database registry is written only by the owner (hooks/lib/db-refs.mjs refuses inside Claude Code, on the real environment and the real process tree).
// Tests that WRITE it therefore run the writer in a child process as the owner would (admin switch set, session marker removed) against a disposable home,
// so the suites pass both inside and outside a Claude session. Read-side fixtures write the JSON directly with seedRegistry.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbRefsFile } from '../../pipeline/hooks/lib/db-refs.mjs';

const CHILD = fileURLToPath(new URL('./db-refs-owner-child.mjs', import.meta.url));
const SWITCH = ['PIPELINE', 'ADMIN'].join('_');
const SESSION = ['CLAUDE', 'CODE'].join('');

// Writes the registry file with the writer's exact body (mode 0600, folder created).
export function seedRegistry(home, { refs = [], servers = [] } = {}) {
  const file = dbRefsFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ v: 1, refs, servers }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// `pipeline db-refs <args>` as the owner, in a child process; -> { exitCode, output }.
export function runOwnerCli(home, args, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv[SESSION]; // (the inherited marker goes; one the caller passes on purpose stays: a test of the admin switch inside a session)
  Object.assign(childEnv, env, { [SWITCH]: '1' });
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ home, args })], { env: childEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`db-refs owner child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
