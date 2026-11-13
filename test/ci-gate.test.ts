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
