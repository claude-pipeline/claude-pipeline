// A stand-in for `gh` that remembers the PR's comments, for the publication tests (test/review-publish.test.mjs, test/cli-triage-claude.test.mjs).
// Same script format and call log as fake-gh.mjs (PIPELINE_FAKE_GH_SCRIPT, PIPELINE_FAKE_GH_LOG) plus a state file (PIPELINE_FAKE_GH_STATE):
//   { me: "<login>", comments: [{id, body, user:{login}, created_at, updated_at}], seq, fail: { write?: true, list?: true, writeAfter?: <n comment writes allowed> } }
// Routes: `api user` (the viewer), GET .../issues/N/comments --paginate, POST .../issues/N/comments, PATCH .../issues/comments/ID. Anything else is
// answered by the script. A state file shared by two checkouts is how two worktrees of one PR see each other's publications.
// The state is written atomically (temp file + rename, retried on Windows' transient EPERM/EACCES/EBUSY) and read with a bounded retry, so a process that
// starts while another is mid-write never sees an empty or partial file (#998).
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const stdin = argv.includes('--input') ? (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })() : '';
if (process.env.PIPELINE_FAKE_GH_LOG) appendFileSync(process.env.PIPELINE_FAKE_GH_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);

const file = process.env.PIPELINE_FAKE_GH_STATE;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readState = () => {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (attempt >= 40) throw e; // ~2 s in all, then the original error
      sleep(50);
    }
  }
};
const writeState = (data) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleep(25);
    }
  }
};
const state = readState();
const out = (json, code = 0, stderr = '') => {
  writeState(JSON.stringify(state));
  if (json !== undefined) process.stdout.write(typeof json === 'string' ? json : JSON.stringify(json));
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
};
const stamp = () => new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + (state.seq = (state.seq ?? 0) + 1) * 1000).toISOString().replace('.000Z', 'Z');
const writable = () => {
  state.writes = (state.writes ?? 0) + 1;
  return !(state.fail?.write || (Number.isInteger(state.fail?.writeAfter) && state.writes > state.fail.writeAfter));
};

if (/^api user/.test(joined)) {
  out(`${state.me ?? 'me'}\n`);
} else if (/^api repos\/[^/]+\/[^/]+\/issues\/\d+\/comments --paginate/.test(joined)) {
  if (state.fail?.list) out(undefined, 1, 'gh: Server Error (HTTP 502)');
  else out(state.comments);
} else if (/^api -X POST repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(joined)) {
  if (!writable()) {
    out(undefined, 1, 'gh: Server Error (HTTP 502)');
  } else {
    const t = stamp();
    const id = 1000 + (state.comments.length + 1);
    state.comments.push({ id, body: JSON.parse(stdin).body, user: { login: state.me ?? 'me' }, created_at: t, updated_at: t, html_url: `https://github.com/x/y/pull/1#issuecomment-${id}` });
    out({ id, html_url: `https://github.com/x/y/pull/1#issuecomment-${id}` });
  }
} else if (/^api -X PATCH repos\/[^/]+\/[^/]+\/issues\/comments\/\d+/.test(joined)) {
  const c = state.comments.find((x) => String(x.id) === /comments\/(\d+)/.exec(joined)[1]);
  if (!c || !writable()) {
    out(undefined, 1, 'gh: Server Error (HTTP 502)');
  } else {
    c.body = JSON.parse(stdin).body;
    c.updated_at = stamp();
    out({ id: c.id, html_url: c.html_url });
  }
} else {
  const hit = JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')).find((e) => new RegExp(e.match).test(joined));
  if (!hit) out(undefined, 99, `fake-gh-comments: no match for ${joined}`);
  else out(hit.stdoutJson !== undefined ? hit.stdoutJson : hit.stdout, hit.code ?? 0, hit.stderr ?? '');
}
