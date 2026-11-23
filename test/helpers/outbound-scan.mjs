// Test plumbing for the outbound text guard (lib/github.mjs): a stub scanner command and the machine-local scan config
// that lists a repository, written into a scratch home that the PIPELINE_OUTBOUND_SCAN_HOME seam points the code at.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const PLANTED = 'PLANTED-PERSONAL-DATUM';

const BODIES = {
  // exits 1 when the text holds PLANTED, saying so on stdout (the hit) and stderr; else 0
  scan: `if (stdin.includes('${PLANTED}')) { process.stdout.write('HIT ${PLANTED}'); process.stderr.write('found ${PLANTED} in the text\\n'); process.exit(1); }`,
  clean: '',
  crash: "process.kill(process.pid, 'SIGKILL');",
  fail2: 'process.exit(2);',
};

// A scanner script in `dir`; every run appends { argv, stdin } to `<script>.log`. -> { command, runs() }.
export function makeScanner(dir, mode = 'scan') {
  const file = join(dir, `scanner-${mode}.mjs`);
  const log = `${file}.log`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const stdin = readFileSync(0, 'utf8');",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');`,
    BODIES[mode],
    '',
  ].join('\n'));
  return {
    command: [process.execPath, file, '--flag'],
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

// Writes the scan config under `home`. `config` is the object (or a raw string, to plant invalid JSON).
export function writeScanConfig(home, config) {
  const file = join(home, '.claude', 'pipeline-local', 'outbound-scan.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}
