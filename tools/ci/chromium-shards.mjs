/**
 * Chromium's two duration-balanced shards: `1`, `2`, or `--plan` for the whole assignment without starting a browser.
 *
 * The planner, the inventory and the filters live in `shard-plan.mjs`, which WebKit's three shards use too. The measurement is
 * `chromium-durations.json`; CONTRIBUTING.md says how to refresh it.
 */
import { readFileSync } from 'node:fs';
import { planShards, runPlannedShard } from './shard-plan.mjs';

const durations = JSON.parse(readFileSync(new URL('./chromium-durations.json', import.meta.url), 'utf8'));
const plan = planShards({ browser: 'chromium', shardCount: 2, durations });
const selection = process.argv[2];

if (selection === '--plan') {
  console.log(JSON.stringify(plan, null, 2));
} else {
  if (selection !== '1' && selection !== '2') throw new Error('Use chromium-shards.mjs 1, 2 or --plan.');
  runPlannedShard({ plan, index: Number(selection), label: 'Chromium', args: ['--reporter=list,blob'] });
}
