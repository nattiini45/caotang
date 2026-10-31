/** The stable required status must wait for every Node and browser acceptance gate. */
import { readFileSync } from 'node:fs';
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

describe('the required pull-request CI gate', () => {
  it('keeps the stable verify status behind both Node versions and all browser jobs', () => {
    const verify = jobBlock(ci, 'verify');
    expect(ci).toContain("node: ['22.12.0', '24']");
    expect(verify).toContain('needs: [verify_matrix, e2e, e2e_browsers, visual]');
    expect(verify).toContain('if: always()');
    for (const result of ['MATRIX_RESULT', 'CHROMIUM_RESULT', 'CROSS_BROWSER_RESULT', 'VISUAL_RESULT']) {
      expect(verify).toContain(`test "$${result}" = success`);
    }
    expect(verify).toContain('needs.verify_matrix.result');
    expect(verify).toContain('needs.e2e.result');
    expect(verify).toContain('needs.e2e_browsers.result');
    expect(verify).toContain('needs.visual.result');
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

  it('gives Firefox a HOME owned by root in the Playwright container', () => {
    const e2e = jobBlock(browsers, 'e2e');
    expect(e2e).toContain('image: mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(e2e).toContain('HOME: /root');
  });
});
