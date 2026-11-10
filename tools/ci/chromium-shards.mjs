import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { source, secondsBySpec } = JSON.parse(readFileSync(new URL('./chromium-durations.json', import.meta.url), 'utf8'));
const isModel = (file) => file.startsWith('e2e/unit/');
const median = (values) => {
  const sorted = values.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const measured = Object.entries(secondsBySpec);
const browserMedian = median(measured.filter(([file]) => !isModel(file)).map(([, seconds]) => seconds));
const modelMedian = median(measured.filter(([file]) => isModel(file)).map(([, seconds]) => seconds));
const separate = new Set(['e2e/modern-gate.spec.ts', 'e2e/modern-reachability.spec.ts', 'e2e/provider-smoke.spec.ts']);
const files = readdirSync(join(root, 'e2e'), { recursive: true })
  .map((file) => `e2e/${file.split(sep).join('/')}`)
  .filter((file) => file.endsWith('.spec.ts') && !file.startsWith('e2e/visual/') && !separate.has(file))
  .map((file) => ({ file, seconds: secondsBySpec[file] ?? (isModel(file) ? modelMedian : browserMedian) }))
  .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
const shards = [0, 1].map(() => ({ files: [], estimatedSeconds: 0, estimatedBrowserSeconds: 0 }));
for (const { file, seconds } of files) {
  const shard = shards[0].estimatedSeconds <= shards[1].estimatedSeconds ? shards[0] : shards[1];
  shard.files.push(file);
  shard.estimatedSeconds += seconds;
  if (!isModel(file)) shard.estimatedBrowserSeconds += seconds;
}
for (const shard of shards) {
  shard.files.sort();
  shard.filters = shard.files.map((file) => `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

const selection = process.argv[2];
if (selection === '--plan') {
  console.log(JSON.stringify({ source, shards }, null, 2));
} else {
  if (selection !== '1' && selection !== '2') throw new Error('Use chromium-shards.mjs 1, 2 or --plan.');
  const shard = shards[Number(selection) - 1];
  console.log(`Chromium shard ${selection}/2: ${shard.files.length} spec files; estimated ${shard.estimatedBrowserSeconds.toFixed(1)} browser worker-seconds. Source: ${source}`);
  const result = spawnSync('pnpm', [
    'exec', 'playwright', 'test', '--reporter=list,blob',
    ...shard.filters,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
