// Timing helpers for "stays linear" tests. A single ms-scale ratio is noise on a shared runner (a Windows CPU clock ticks every
// ~15 ms: 15 ms -> 47 ms once failed a linear scan), so a sample is the BEST of several runs: noise only ever adds time, never
// removes it, and a real quadratic or exponential blow-up stays slow on every run.
import assert from 'node:assert/strict';

// The CPU clock: the main thread's own CPU time where Node has it (process.threadCpuUsage, newer Node), else the whole process's.
// The thread clock leaves out the GC and helper threads, which share the cores with parallel test files on a CI runner and inflate the
// process figure; Node 20 lacks it. Detected once.
const cpuUsage = typeof process.threadCpuUsage === 'function' ? (prev) => process.threadCpuUsage(prev) : (prev) => process.cpuUsage(prev);

// CPU time (user + system) `fn` burns, in ms. CPU time ignores the time the OS spent running something else.
export function cpuTime(fn) {
  const t0 = cpuUsage();
  fn();
  const d = cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

// Runs `fn` once; returns its value and the CPU ms it burned. Load-proof like cpuTime, for caps that also need the result.
export function cpuTimed(fn) {
  const t0 = cpuUsage();
  const r = fn();
  const d = cpuUsage(t0);
  return { r, ms: (d.user + d.system) / 1000 };
}

// The fastest of `runs` samples; `sample()` returns a number of ms.
export function bestOf(runs, sample) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, sample());
  return best;
}

// Asserts that `large()` (`factor` times the input of `small()`, default 2) takes under `ratio` times as long (a linear scan gives ~factor,
// a quadratic one ~factor^2). A wider span (e.g. factor 16, ratio 64: linear 16x, quadratic 256x) absorbs a per-byte cost that climbs
// across several doublings (the input outgrowing the CPU cache) that a single doubling cannot, with 4x margin on each side.
// Both return ms. One warm-up run of `small` is discarded (JIT, caches). The baseline is the best of `smallRuns`; the large run is
// repeated until it passes, at most `largeRuns` times, so a slow sample cannot fail the test but a slow best-of-all cannot pass.
// That is one ROUND. A burst of machine load can still slow every sample of one round (a GC storm, a neighbour's test file), so a failed
// round is followed by a fresh one (warm-up, baseline and large runs all re-measured), up to `rounds` (default 3); the check fails only
// when EVERY round fails, and the message lists each round's baseline / large time. The ratio, factor and slack apply unchanged to each
// round, so a real quadratic (slow on every sample of every round) still fails.
// The check also passes when the excess over a perfectly linear run is below `slackMs`: under the clock's resolution there is
// nothing to measure. Size the inputs so the baseline is well above that slack (tens of ms), or a quadratic one slips through it.
export function assertLinear(small, large, { label = 'work', ratio = 3, slackMs = 25, smallRuns = 3, largeRuns = 5, factor = 2, rounds = 3 } = {}) {
  const results = [];
  for (let round = 0; round < rounds; round++) {
    small();
    const lo = Math.max(bestOf(smallRuns, small), 1);
    let hi = Infinity;
    for (let i = 0; i < largeRuns; i++) {
      hi = Math.min(hi, large());
      if (hi / lo < ratio || hi - factor * lo < slackMs) return { lo, hi };
    }
    results.push({ lo, hi });
  }
  const [first] = results;
  const each = results.map((r) => `${Math.round(r.lo)}/${Math.round(r.hi)}`).join(', ');
  assert.fail(`${label}: ${Math.round(first.lo)}ms at n/${factor} -> ${Math.round(first.hi)}ms at n (best of ${largeRuns}): not linear in all ${rounds} rounds (lo/hi ms per round: ${each})`);
}
