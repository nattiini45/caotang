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

/**
 * The suites `CAOTANG_SKIP_WORKER_SUITES` leaves out, each of which boots its own Miniflare Worker runtime per case: too slow for
 * GitHub's Windows runner to finish inside the case deadline (#815, and #820 for the third). The list lives here so the two
 * Windows legs' step names and the exclusion itself are checked against one another rather than each being trusted alone.
 */
const WORKER_SUITE_FILES = ['account-mode', 'storage', 'server'];

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

  it('splits both browsers into three shards without dropping coverage or hiding interrupted progress', () => {
    const e2e = jobBlock(browsers, 'e2e');
    expect(e2e).toContain('browser: [firefox, webkit]');
    expect(e2e).toContain('shard: [1, 2, 3, modern]');
    expect(e2e).not.toContain('exclude:');
    expect(e2e).toContain("format('{0}/3', matrix.shard)");
    // Firefox keeps Playwright's own count-based split; WebKit's numbered legs take the measured plan instead, which passes the
    // same project and the same reporters from inside the tool.
    expect(e2e).toContain('--project=firefox --shard=${{ matrix.shard }}/3 --workers=2 --reporter=blob,list');
    expect(e2e).toContain('run: node tools/ci/webkit-shards.mjs "$SHARD"');
    expect(read('tools/ci/webkit-shards.mjs')).toContain("'--project=webkit', '--workers=2', '--reporter=blob,list'");
    expect(e2e).toContain('name: blob-report-${{ matrix.browser }}-${{ matrix.shard }}');
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
 * WebKit's shards are balanced by measured duration rather than by test count.
 *
 * The union check is the point: a plan that loses a spec runs the suite with a hole in it and still reports green, and a plan
 * that assigns one twice spends a leg's time twice. So the assignment must cover the WebKit inventory exactly once, the filters
 * must select exactly the assigned files and nothing else, and the inventory must be the config's — not a second, drifting copy
 * of what WebKit runs.
 */
describe('the duration-balanced WebKit shards', () => {
  type Shard = { files: string[]; filters: string[]; estimatedBrowserSeconds: number };
  const plan = JSON.parse(
    execFileSync(process.execPath, [resolve(root, 'tools/ci/webkit-shards.mjs'), '--plan'], { cwd: root, encoding: 'utf8' }),
  ) as { source: string; inventory: number; shards: Shard[] };
  const assigned = plan.shards.flatMap((shard) => shard.files);

  it('assigns every WebKit spec exactly once', () => {
    expect(plan.shards).toHaveLength(3);
    expect(plan.inventory).toBe(assigned.length);
    expect(new Set(assigned).size, 'a spec is assigned to two shards').toBe(assigned.length);
    for (const file of ['e2e/agent-sessions.spec.ts', 'e2e/non-chromium-storage.spec.ts', 'e2e/settings-providers.spec.ts']) {
      expect(assigned, file).toContain(file);
    }
    // What the webkit project leaves to Chromium, and what the Modern gate runs in its own leg, is never in a numbered shard.
    for (const file of [
      'e2e/unit/agent-restore.spec.ts',
      'e2e/prod-smoke.spec.ts',
      'e2e/provider-smoke.spec.ts',
      'e2e/mobile-shell.spec.ts',
      'e2e/modern-gate.spec.ts',
    ]) {
      expect(assigned, file).not.toContain(file);
    }
  });

  it("selects exactly its own files, so no shard runs another shard's specs", () => {
    for (const shard of plan.shards) {
      const filters = shard.filters.map((filter) => new RegExp(filter));
      expect(assigned.filter((file) => filters.some((filter) => filter.test(file))).sort()).toEqual([...shard.files].sort());
      for (const [index, file] of shard.files.entries()) {
        expect(filters[index]?.test(`${file}-extra`)).toBe(false);
        expect(filters[index]?.test(file.replaceAll('.', 'X'))).toBe(false);
      }
    }
  });

  it('balances measured browser time, not test counts', () => {
    const total = plan.shards.reduce((sum, shard) => sum + shard.estimatedBrowserSeconds, 0);
    expect(total).toBeGreaterThan(0);
    for (const shard of plan.shards) {
      expect(shard.estimatedBrowserSeconds / total).toBeGreaterThan(0.31);
      expect(shard.estimatedBrowserSeconds / total).toBeLessThan(0.355);
    }
  });

  it('measures every spec it names, and names no spec that is gone', () => {
    const { source, secondsBySpec } = JSON.parse(read('tools/ci/webkit-durations.json')) as {
      source: string;
      secondsBySpec: Record<string, number>;
    };
    expect(source).toMatch(/^https:\/\/github\.com\//);
    expect(Object.keys(secondsBySpec).length).toBeGreaterThan(100);
    for (const [file, seconds] of Object.entries(secondsBySpec)) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
      expect(Number.isFinite(seconds) && seconds >= 0, file).toBe(true);
    }
  });

  it('leaves to Chromium exactly what playwright.config.ts leaves to Chromium', () => {
    // Two copies of one rule: the config's `chromiumOnlySpecs` decides what a browser project runs, and the planner decides what
    // a shard takes. A spec named by one and not the other is either dead weight or a hole, so the same names must appear.
    const listed = /const chromiumOnlySpecs = \[([\s\S]*?)\];/.exec(read('playwright.config.ts'))?.[1] ?? '';
    const planner = read('tools/ci/shard-plan.mjs');
    for (const name of ['prod-smoke', 'providers-cors', 'provider-smoke', 'mobile-shell', String.raw`e2e[\\/]unit`, String.raw`e2e[\\/]visual`]) {
      expect(listed, `playwright.config.ts chromiumOnlySpecs must name ${name}`).toContain(name);
      expect(planner, `shard-plan.mjs must name ${name}`).toContain(name);
    }
  });

  it("falls back to Playwright's own sharding when no plan can be built", () => {
    const tool = read('tools/ci/webkit-shards.mjs');
    expect(tool).toContain('nativeShard(index');
    expect(tool).toContain('--shard=${index}/${SHARDS}');
    expect(tool).toContain('catch (error) {');
  });
});

/**
 * The Node floor and the whole gate: one leg proves the floor, the other proves everything.
 *
 * Both legs used to run `pnpm verify` plus every build, so the same 10 minutes of lint, typecheck and 14.5k unit tests ran
 * twice for one answer. The gate is now the newer Node's; the Node 22.19.0 leg keeps what only it can prove — that the floor
 * installs under `--engine-strict`, typechecks, builds, bundles the command line and runs the tests whose subject is a Node
 * process. The guard keeps that split from silently becoming "no gate" (both legs narrowed) or "two gates again" (the floor
 * leg quietly regaining the full suite).
 */
describe('the Node floor and the whole gate', () => {
  const matrix = jobBlock(ci, 'verify_matrix');
  const steps = matrix.split(/^ {6}- /m).slice(1);
  const step = (name: string): string => {
    const hit = steps.find((candidate) => candidate.startsWith(`name: ${name}`));
    if (!hit) throw new Error(`verify_matrix has no "${name}" step`);
    return hit;
  };
  const floorOnly = ['Typecheck (the Node floor)', 'Unit tests that run in Node itself (the Node floor)'];
  const gateOnly = [
    'Lint, typecheck and every unit suite (the whole gate, once)',
    'Bundle size (chunk caps, first load, total JS)',
    'Build the landing page (site/dist, as the pages workflow publishes it)',
    'Landing page size (HTML, CSS and assets caps; no JavaScript)',
    'Pack the MCP server bundle (manifest checked by the pinned MCPB CLI)',
  ];

  it('keeps both matrix check names, so neither required status is renamed', () => {
    expect(matrix).toContain('name: verify (Node ${{ matrix.node }})');
    expect(matrix).toContain("node: ['22.19.0', '24']");
  });

  it('runs the whole gate once, on the newer Node', () => {
    expect(matrix.match(/run: pnpm verify/g), 'the full gate must run exactly once').toHaveLength(1);
    for (const name of gateOnly) expect(step(name), name).toContain("if: matrix.node == '24'");
  });

  it('keeps on the floor leg only what proves the floor', () => {
    for (const name of floorOnly) expect(step(name), name).toContain("if: matrix.node == '22.19.0'");
    expect(step(floorOnly[0]!)).toContain('run: pnpm run typecheck');
    expect(step(floorOnly[1]!)).toContain('run: pnpm run test:node-floor');
    // The engine-strict install and the production build stay unguarded: they are what both legs exist to prove, and the
    // floor's install is the one that refuses a package whose `engines` leaves Node 22 out.
    expect(step('Install (frozen lockfile, strict engines)')).toContain('--engine-strict');
    expect(step('Install (frozen lockfile, strict engines)')).not.toContain('if:');
    expect(step('Production build (desktop app, with its notices)')).not.toContain('if:');
    // The command-line bundle and the scan of a real project with it run on both legs: that is the shipped Node program.
    expect(step('Build the caotang command-line bundle (one file, with its fonts/)')).not.toContain('if:');
    expect(step('Scan the fixture project with the built command (exit 7, one error annotation, nothing written)')).not.toContain('if:');
  });

  it('names a floor-test set that exists on disk and keeps every Node host in it', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    const script = scripts['test:node-floor'];
    if (script === undefined) throw new Error('package.json has no test:node-floor script');
    const filters = script.replace(/^vitest run /, '').split(/\s+/);
    // Every filter is a real path: a renamed spec dir would otherwise turn this leg into a smaller one without a word.
    for (const filter of filters) expect(existsSync(resolve(root, filter)), filter).toBe(true);
    for (const host of ['packages/cli/test', 'packages/sdk/test', 'packages/mcp-server/test', 'packages/sync-server/test']) {
      expect(filters, `the floor leg must keep ${host}`).toContain(host);
    }
  });
});

/**
 * The packaging workflow gates a released commit as strictly as a merged one.
 *
 * Its Windows leg once ran `pnpm run typecheck` alone, because the suite was not ported to that runner. That is the one place
 * the gate could narrow without anyone noticing: a tag would ship from a commit whose unit suites never ran. The guard keeps
 * every leg on `pnpm verify`, names the files the one documented exclusion covers, and keeps it from spreading by copy.
 */
describe('the packaging legs run the gate', () => {
  const release = read('.github/workflows/desktop-release.yml');
  const windows = jobBlock(release, 'build-windows');
  const macAndLinux = jobBlock(release, 'build-mac-linux');

  it('runs the whole gate on every leg, never a typecheck alone', () => {
    for (const [id, leg] of [['build-windows', windows], ['build-mac-linux', macAndLinux]] as const) {
      expect(leg, id).toContain('run: pnpm verify');
      expect(leg, id).not.toContain('run: pnpm run typecheck');
    }
  });

  it('leaves the Worker suites out on Windows only, and names each of them in the step', () => {
    expect(windows).toContain("CAOTANG_SKIP_WORKER_SUITES: '1'");
    expect(macAndLinux).not.toContain('CAOTANG_SKIP_WORKER_SUITES');
    const names = [...windows.slice(0, windows.indexOf('CAOTANG_SKIP_WORKER_SUITES')).matchAll(/^ {6}- name: (.*)$/gm)];
    const name = names.at(-1)?.[1];
    if (name === undefined) throw new Error('the Windows leg has no named step before the exclusion');
    for (const file of WORKER_SUITE_FILES) expect(name, file).toContain(file);
    expect(name).toContain('boots a Worker runtime per case');
  });

  it('excludes exactly the suites its step names, so neither can drift from the other', () => {
    const excluded = [.../CAOTANG_SKIP_WORKER_SUITES'\] === '1'\s*\? \[([^\]]+)\]/.exec(read('vitest.config.ts'))![1]!.matchAll(/test\/([\w-]+)\.test\.ts/g)].map((match) => match[1]!);
    expect(excluded).toEqual(WORKER_SUITE_FILES.map((file) => file));
  });
});
