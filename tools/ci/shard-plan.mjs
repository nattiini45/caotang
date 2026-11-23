/**
 * The duration-balanced shard planner the browser legs share.
 *
 * Chromium's two shards and WebKit's three are the same problem: a set of spec files with measured seconds each, split so the
 * legs finish together. The measurement lives in a `*-durations.json` beside this file, refreshed from a completed zero-retry
 * run (CONTRIBUTING.md), and a spec with no measurement takes the median of its kind — the browser specs' median, or the pure
 * model specs' own much smaller median.
 *
 * What this cannot do is promise a wall time: a spec's own duration moves by 10–20 % between runs, so the planner removes the
 * *assignable* imbalance and leaves the rest. A changed workload needs a new measurement, not a new algorithm.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/** The Modern gate's two specs, and the real-key round: each runs in a job of its own, so no numbered shard takes them. */
const separateSpecs = [
  /[\\/]e2e[\\/]modern-gate\.spec\.ts$/,
  /[\\/]e2e[\\/]modern-reachability\.spec\.ts$/,
  /[\\/]e2e[\\/]provider-smoke\.spec\.ts$/,
];

/** The Classic screenshots are comparable only with the pinned Playwright image, and run in their own job. */
const visualSpecs = /[\\/]e2e[\\/]visual[\\/]/;

/**
 * What the `firefox` and `webkit` projects leave to Chromium — playwright.config.ts's `chromiumOnlySpecs`, restated here because
 * the config is TypeScript with side effects and this is a script. `test/ci-gate.test.ts` reads both and fails when they
 * disagree: a spec assigned to a leg that never runs it is dead weight, and a spec the config runs but no plan assigns is a
 * silent hole in the suite.
 */
export const chromiumOnlySpecs = [
  /[\\/]e2e[\\/]unit[\\/]/,
  /[\\/]prod-smoke\.spec\.ts$/,
  /[\\/]providers-cors\.spec\.ts$/,
  /[\\/]provider-smoke\.spec\.ts$/,
  /[\\/]mobile-shell\.spec\.ts$/,
];

/**
 * The config writes its patterns for absolute paths, where `e2e` always has a separator before it. A plan holds relative
 * paths, so each one is tested with a leading slash: without it `/[\\/]e2e[\\/]unit[\\/]/` matches nothing and the inventory
 * silently keeps every spec the browser never runs.
 */
const matches = (patterns, file) => patterns.some((pattern) => pattern.test(`/${file}`));

const isModel = (file) => file.startsWith('e2e/unit/');

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Every spec this browser's project runs, in the order they are read. */
export function inventory(browser) {
  const specs = readdirSync(join(root, 'e2e'), { recursive: true })
    .map((file) => `e2e/${String(file).split(sep).join('/')}`)
    .filter((file) => file.endsWith('.spec.ts') && !matches([visualSpecs, ...separateSpecs], file));
  return browser === 'chromium' ? specs : specs.filter((file) => !matches(chromiumOnlySpecs, file));
}

/**
 * Longest-processing-time first: the slowest spec goes on the lightest shard, and every shard ends with the filters that select
 * exactly its files. Throws when the plan does not assign every spec of the inventory exactly once, because a shard list that
 * lost a spec would run the suite with a hole in it and still report green.
 */
export function planShards({ browser, shardCount, durations }) {
  const { source, secondsBySpec } = durations;
  const measured = Object.entries(secondsBySpec);
  if (measured.length === 0) throw new Error(`${browser}: the durations file records no spec`);
  const browserMedian = medianOf(measured.filter(([file]) => !isModel(file)).map(([, seconds]) => seconds));
  const modelMedian = medianOf(measured.filter(([file]) => isModel(file)).map(([, seconds]) => seconds));
  const specs = inventory(browser).map((file) => ({
    file,
    seconds: secondsBySpec[file] ?? (isModel(file) ? modelMedian : browserMedian),
  }));
  specs.sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));

  const shards = Array.from({ length: shardCount }, () => ({ files: [], estimatedSeconds: 0, estimatedBrowserSeconds: 0 }));
  for (const { file, seconds } of specs) {
    const lightest = shards.reduce((chosen, candidate) => (candidate.estimatedSeconds < chosen.estimatedSeconds ? candidate : chosen));
    lightest.files.push(file);
    lightest.estimatedSeconds += seconds;
    if (!isModel(file)) lightest.estimatedBrowserSeconds += seconds;
  }
  for (const shard of shards) {
    shard.files.sort();
    shard.filters = shard.files.map((file) => `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  }

  const assigned = shards.flatMap((shard) => shard.files);
  if (assigned.length !== specs.length || new Set(assigned).size !== assigned.length) {
    throw new Error(`${browser}: the plan assigns ${assigned.length} specs for an inventory of ${specs.length}, with duplicates`);
  }
  return { source, inventory: specs.length, shards };
}

/** Runs one shard of the plan, so Playwright selects exactly the files the plan gave it. */
export function runPlannedShard({ plan, index, label, args }) {
  const shard = plan.shards[index - 1];
  console.log(
    `${label} shard ${index}/${plan.shards.length}: ${shard.files.length} spec files; estimated ` +
      `${shard.estimatedBrowserSeconds.toFixed(1)} browser worker-seconds. Source: ${plan.source}`,
  );
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...args, ...shard.filters], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
