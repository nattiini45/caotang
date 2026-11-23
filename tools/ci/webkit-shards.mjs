/**
 * WebKit's three duration-balanced shards: `1`, `2`, `3`, or `--plan` for the whole assignment without starting a browser.
 *
 * Why this exists rather than Playwright's own `--shard`: Playwright splits by test count, and WebKit's specs differ by more than
 * a hundredfold (e2e/agent-sessions.spec.ts is 467 s, an e2e/unit spec is under a second), so a count-based third leaves one leg
 * carrying the slow specs. The measurement is `webkit-durations.json`, refreshed the way CONTRIBUTING.md describes.
 *
 * The fallback is deliberate: a plan that cannot be built — a durations file that is missing, unparseable or empty, an inventory
 * that comes back empty — runs the leg with Playwright's own `--shard=<n>/3` and says so in the log, because a tooling fault must
 * not fail a suite whose tests are fine. A plan that *is* built must cover every WebKit spec exactly once; `planShards` throws
 * otherwise and this falls back rather than run with a hole.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { planShards, root, runPlannedShard } from './shard-plan.mjs';

const SHARDS = 3;
const args = ['--project=webkit', '--workers=2', '--reporter=blob,list'];

function planned() {
  return planShards({
    browser: 'webkit',
    shardCount: SHARDS,
    durations: JSON.parse(readFileSync(new URL('./webkit-durations.json', import.meta.url), 'utf8')),
  });
}

function nativeShard(index, reason) {
  console.warn(`WebKit shard ${index}/${SHARDS}: ${reason}; running Playwright's own --shard=${index}/${SHARDS} instead.`);
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...args, `--shard=${index}/${SHARDS}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const selection = process.argv[2];

if (selection === '--plan') {
  console.log(JSON.stringify(planned(), null, 2));
} else {
  const index = Number(selection);
  if (!Number.isInteger(index) || index < 1 || index > SHARDS) throw new Error(`Use webkit-shards.mjs 1, 2, 3 or --plan.`);
  let plan;
  try {
    plan = planned();
  } catch (error) {
    nativeShard(index, `no plan (${error instanceof Error ? error.message : String(error)})`);
  }
  runPlannedShard({ plan, index, label: 'WebKit', args });
}
