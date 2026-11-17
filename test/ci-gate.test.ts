/** The stable required status must wait for every Node and browser acceptance gate. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');

function jobBlock(workflow: string, id: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  if (jobsStart < 0) throw new Error('workflow has no jobs block');
  const jobs = workflow.slice(jobsStart);
  const start = new RegExp(`^ {2}${id}:\\s*$`, 'm').exec(jobs);
  if (!start) throw new Error(`workflow has no top-level ${id} job`);
  const blockStart = start.index;
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(jobs.slice(blockStart + start[0].length));
  const blockEnd = next ? blockStart + start[0].length + next.index : jobs.length;
  return jobs.slice(blockStart, blockEnd);
}

/** Every top-level job of a workflow, by id, for the checks that hold across the whole file. */
function jobBlocks(workflow: string): { id: string; body: string }[] {
  const jobsStart = workflow.indexOf('\njobs:\n');
  if (jobsStart < 0) throw new Error('workflow has no jobs block');
  const blocks: { id: string; body: string }[] = [];
  for (const line of workflow.slice(jobsStart).split('\n').slice(1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) blocks.push({ id: header[1]!, body: '' });
    else if (blocks.length > 0) blocks[blocks.length - 1]!.body += `${line}\n`;
  }
  return blocks;
}

const ci = read('.github/workflows/ci.yml');
const browsers = read('.github/workflows/e2e-browsers.yml');
const summaryScript = jobBlock(ci, 'e2e').split('        run: |\n')[1]?.split('\n').map((line) => line.slice(10)).join('\n') ?? '';

describe('the required pull-request CI gate', () => {
  it('keeps the stable verify status behind both Node versions and all browser jobs', () => {
    const verify = jobBlock(ci, 'verify');
    expect(ci).toContain("node: ['22.19.0', '24']");
    expect(verify).toContain('needs: [verify_matrix, e2e, e2e_modern, e2e_browsers, visual]');
    expect(verify).toContain('if: always()');
    for (const result of ['MATRIX_RESULT', 'CHROMIUM_RESULT', 'MODERN_RESULT', 'CROSS_BROWSER_RESULT', 'VISUAL_RESULT']) {
      expect(verify).toContain(`test "$${result}" = success`);
    }
    expect(verify).toContain('needs.verify_matrix.result');
    expect(verify).toContain('needs.e2e.result');
    expect(verify).toContain('needs.e2e_modern.result');
    expect(verify).toContain('needs.e2e_browsers.result');
    expect(verify).toContain('needs.visual.result');
  });

  it('keeps the Chromium summary and Modern gate check names and requires both shards', () => {
    const summary = jobBlock(ci, 'e2e');
    const shards = jobBlock(ci, 'e2e_shards');
    const modern = jobBlock(ci, 'e2e_modern');
    expect(summary).toContain('name: e2e (chromium)');
    expect(summary).toContain('needs: [e2e_shards, e2e_reports]');
    expect(summary).toContain('if: always()');
    expect(summary).toContain('SHARDS_RESULT: ${{ needs.e2e_shards.result }}');
    expect(summary).toContain('REPORTS_RESULT: ${{ needs.e2e_reports.result }}');
    expect(shards).toContain('shard: [1, 2]');
    expect(shards).toContain('fail-fast: false');
    expect(shards).toContain('timeout-minutes: 45');
    expect(shards).toContain('run: node tools/ci/chromium-shards.mjs "$SHARD"');
    expect(shards).toContain('SHARD: ${{ matrix.shard }}');
    expect(shards).toContain('CAOTANG_E2E_MODERN_GATE: skip');
    expect(shards).not.toContain('continue-on-error');
    expect(shards).not.toContain('--workers');
    expect(modern).toContain('name: e2e (chromium, Modern gate)');
    expect(modern).toContain('timeout-minutes: 30');
    expect(modern).not.toContain('needs:');
    expect(modern).toContain('run: pnpm exec playwright test --project=chromium e2e/modern-reachability.spec.ts e2e/modern-gate.spec.ts');
    expect(spawnSync('bash', ['-e', '-o', 'pipefail', '-c', summaryScript], {
      env: { ...process.env, SHARDS_RESULT: 'success', REPORTS_RESULT: 'success' },
    }).status).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])('fails the Chromium summary for an unsuccessful dependency (%s)', (result) => {
    for (const dependency of ['SHARDS_RESULT', 'REPORTS_RESULT']) {
      expect(spawnSync('bash', ['-e', '-o', 'pipefail', '-c', summaryScript], {
        env: { ...process.env, SHARDS_RESULT: 'success', REPORTS_RESULT: 'success', [dependency]: result },
      }).status).toBe(1);
    }
  });

  it('assigns every suite spec exactly once and balances browser duration rather than case count', () => {
    const plan = JSON.parse(execFileSync(process.execPath, [resolve(root, 'tools/ci/chromium-shards.mjs'), '--plan'], {
      cwd: root, encoding: 'utf8',
    })) as { shards: { files: string[]; filters: string[]; estimatedBrowserSeconds: number }[] };
    const inventory = readdirSync(resolve(root, 'e2e'), { recursive: true })
      .map((file) => `e2e/${String(file).replaceAll('\\', '/')}`)
      .filter((file) => file.endsWith('.spec.ts') && !file.startsWith('e2e/visual/')
        && !['e2e/modern-gate.spec.ts', 'e2e/modern-reachability.spec.ts', 'e2e/provider-smoke.spec.ts'].includes(file));
    expect(plan.shards).toHaveLength(2);
    const assigned = plan.shards.flatMap((shard) => shard.files);
    expect(assigned.sort()).toEqual(inventory.sort());
    expect(new Set(assigned).size).toBe(assigned.length);
    const browserSeconds = plan.shards.reduce((total, shard) => total + shard.estimatedBrowserSeconds, 0);
    for (const shard of plan.shards) {
      const filters = shard.filters.map((filter) => new RegExp(filter));
      expect(inventory.filter((file) => filters.some((filter) => filter.test(file))).sort()).toEqual(shard.files);
      for (const [index, file] of shard.files.entries()) {
        expect(filters[index]?.test(`${file}-extra`)).toBe(false);
        expect(filters[index]?.test(file.replaceAll('.', 'X'))).toBe(false);
      }
      expect(shard.files.some((file) => file.startsWith('e2e/unit/'))).toBe(true);
      expect(shard.estimatedBrowserSeconds / browserSeconds).toBeGreaterThan(0.48);
      expect(shard.estimatedBrowserSeconds / browserSeconds).toBeLessThan(0.52);
    }
    const { secondsBySpec } = JSON.parse(read('tools/ci/chromium-durations.json')) as { secondsBySpec: Record<string, number> };
    for (const [file, seconds] of Object.entries(secondsBySpec)) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
      expect(Number.isFinite(seconds) && seconds >= 0, file).toBe(true);
    }
  });

  it('merges Chromium reports without consuming or overwriting Firefox/WebKit artifacts', () => {
    const shards = jobBlock(ci, 'e2e_shards');
    const reports = jobBlock(ci, 'e2e_reports');
    expect(shards).toContain('name: chromium-blob-report-${{ matrix.shard }}');
    expect(shards).toContain('if-no-files-found: error');
    expect(reports).toContain('needs: e2e_shards');
    expect(reports).toContain('pattern: chromium-blob-report-*');
    expect(reports).toContain('run: pnpm exec playwright merge-reports --reporter=html ./all-chromium-blob-reports');
    expect(reports).toContain('name: chromium-playwright-report');
    expect(browsers).toContain('pattern: blob-report-*');
  });

  it('calls the Firefox/WebKit workflow from the required gate and keeps merged shard reports', () => {
    expect(jobBlock(ci, 'e2e_browsers')).toContain('uses: ./.github/workflows/e2e-browsers.yml');
    expect(browsers).toMatch(/^on:\n {2}workflow_call:\n/m);
    expect(browsers).toContain('browser: [firefox, webkit]');
    expect(browsers).toContain('merge-reports:');
    expect(browsers).toContain('workflow_dispatch:');
    expect(browsers).toContain('schedule:');
    expect(browsers).toContain('group: e2e-browsers-${{ github.event_name }}-${{ github.ref }}');
  });

  it('runs the Classic snapshots in the pinned Playwright image, and only with CAOTANG_VISUAL', () => {
    const visual = jobBlock(ci, 'visual');
    expect(visual).toContain('image: mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(visual).toContain("CAOTANG_VISUAL: '1'");
    expect(visual).toContain('pnpm exec playwright test --project=visual');
    expect(read('playwright.config.ts')).toContain("const visual = process.env['CAOTANG_VISUAL'] === '1';");
  });

  it('splits Firefox into three shards without changing WebKit coverage or hiding interrupted progress', () => {
    const e2e = jobBlock(browsers, 'e2e');
    expect(e2e).toContain('shard: [1, 2, 3, modern]');
    expect(e2e).toContain('exclude:\n          - browser: webkit\n            shard: 3');
    expect(e2e).toContain("format('{0}/{1}', matrix.shard, matrix.browser == 'firefox' && 3 || 2)");
    expect(e2e).toContain("--shard=${{ matrix.shard }}/${{ matrix.browser == 'firefox' && 3 || 2 }}");
    expect(e2e.match(/--workers=2 --reporter=blob,list/g)).toHaveLength(2);
    expect(e2e).toContain('timeout-minutes: 40');
    expect(e2e).toContain('fail-fast: false');
    expect(e2e).toContain('CAOTANG_E2E_MODERN_GATE: skip');
    expect(e2e).not.toContain('--timeout');
    expect(e2e).not.toContain('--retries');
    expect(e2e).not.toContain('continue-on-error');
  });

  it('gives Firefox a HOME owned by root in the Playwright container', () => {
    const e2e = jobBlock(browsers, 'e2e');
    expect(e2e).toContain('image: mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(e2e).toContain('HOME: /root');
  });
});

/**
 * The pnpm store cache: a job that installs pays for the download once, not once per job.
 *
 * The guard is the pairing, not the existence of the action. An install that lands in a job without the restore step is
 * silent — the job simply runs slower, and nothing fails — which is the direction this repository's guards exist to close.
 * So every job whose steps run `pnpm install` must restore the store above that line, in every workflow, including the
 * release, pages and desktop workflows that no pull request exercises.
 */
describe('the pnpm store cache', () => {
  const store = read('.github/actions/pnpm-store/action.yml');

  it('restores the store above every pnpm install, in every workflow that has one', () => {
    const installed: string[] = [];
    const unpaired: string[] = [];
    for (const file of readdirSync(resolve(root, '.github/workflows')).filter((name) => name.endsWith('.yml'))) {
      for (const job of jobBlocks(read(`.github/workflows/${file}`))) {
        const at = job.body.indexOf('run: pnpm install');
        if (at < 0) continue;
        installed.push(`${file}: ${job.id}`);
        const restore = job.body.indexOf('uses: ./.github/actions/pnpm-store');
        if (restore < 0 || restore > at) unpaired.push(`${file}: ${job.id}`);
      }
    }
    // The subject has to exist before its absence assertions mean anything: a parse that finds no installing job would
    // satisfy every claim below while checking nothing.
    expect(installed.length).toBeGreaterThanOrEqual(10);
    expect(unpaired, 'jobs that install without restoring the pnpm store first').toEqual([]);
  });

  it('keys the store by the lockfile and the runner OS, over the path pnpm reports for itself', () => {
    // The path is asked of pnpm rather than hard-coded: it moves with pnpm's major and with HOME, so a literal would cache a
    // directory the install never reads, and `actions/cache` would still report a hit.
    expect(store).toContain('pnpm store path');
    expect(store).toContain('path: ${{ steps.store.outputs.path }}');
    expect(store).toContain('pnpm-lock.yaml');
    // The lockfile's own hash and the runner's OS, both in the key: a store is content-addressed, so a new lockfile is a new
    // key, and a Linux store is never offered to Windows.
    expect(store).toMatch(/key: pnpm-store-\$\{\{ runner\.os \}\}-.*\$\{\{ steps\.store\.outputs\.lockfile \}\}/);
    expect(store).toContain('restore-keys: pnpm-store-${{ runner.os }}-');
    expect(store).toContain('uses: actions/cache@v6');
  });
});
