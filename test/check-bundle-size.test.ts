/**
 * The bundle-size gate (tools/check-bundle-size.mjs), on fake sizes: what it accepts, and each way it fails. The real numbers are
 * the script's BUDGET, set from a build, and CI runs the script on the build itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, analyse, chunkName, initialFilesOf, readBuild, renderReport, type Budget, type Chunk } from '../tools/check-bundle-size.mjs';

const kB = (n: number): number => n * 1000;

const budget: Budget = {
  chunkLimit: kB(500),
  allow: { 'fontkit.es': kB(750), app: kB(640) },
  initialGzip: kB(700),
  totalJs: kB(5000),
};

function chunk(file: string, rawKb: number, gzipKb = rawKb / 3): Chunk {
  return { file, bytes: kB(rawKb), gzip: kB(gzipKb) };
}

/** A build that passes: an entry, one allow-listed app chunk, fontkit lazy, and a few small lazy chunks. */
const GOOD: readonly Chunk[] = [
  chunk('index-aVYiHL54.js', 400),
  chunk('app-9gel3XQa.js', 600),
  chunk('fontkit.es-B1-xruQ9.js', 711),
  chunk('wire-QBW0gQ5L.js', 313),
  chunk('es-DAMQN0Qa.js', 382),
];
const INITIAL = ['index-aVYiHL54.js', 'app-9gel3XQa.js'];

describe('chunkName', () => {
  it('drops the extension and the 8-character hash, whatever characters the hash holds', () => {
    expect(chunkName('index-aVYiHL54.js')).toBe('index');
    expect(chunkName('fontkit.es-B1-xruQ9.js')).toBe('fontkit.es');
    expect(chunkName('NotoSansMonoCJKsc-Regular-ChO2Pj-J.js')).toBe('NotoSansMonoCJKsc-Regular');
    expect(chunkName('vendor-react-BF-f0fsR.js')).toBe('vendor-react');
  });

  it('leaves a name without a hash as it is', () => {
    expect(chunkName('main.js')).toBe('main');
  });
});

describe('initialFilesOf', () => {
  const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/app/assets/index-aVYiHL54.js"></script>
    <link rel="modulepreload" crossorigin href="/app/assets/vendor-react-BF-f0fsR.js">
    <link rel="stylesheet" crossorigin href="/app/assets/index-DVvcK7w0.css">
    <link rel="modulepreload" href="/app/assets/width-D_Ch_kz3.js">
  </head><body><div id="root"></div></body></html>`;

  it('lists the module script and the modulepreload links, and not the stylesheet', () => {
    expect(initialFilesOf(html)).toEqual(['index-aVYiHL54.js', 'vendor-react-BF-f0fsR.js', 'width-D_Ch_kz3.js']);
  });

  it('reads a tag whose attributes come in another order, and skips a comment that names a script', () => {
    const other =
      '<!-- <script src="/assets/x-AAAAAAAA.js"> --><link href="/assets/a-BBBBBBBB.js" rel="modulepreload"><script src="/assets/b-CCCCCCCC.js" type="module"></script>';
    expect(initialFilesOf(other)).toEqual(['a-BBBBBBBB.js', 'b-CCCCCCCC.js']);
  });
});

describe('analyse', () => {
  it('passes a build inside every limit', () => {
    const report = analyse(GOOD, INITIAL, budget);
    expect(report.problems).toEqual([]);
    expect(report.initialGzip).toBeCloseTo(kB(400 / 3) + kB(600 / 3), 3);
    expect(report.totalJs).toBe(kB(400 + 600 + 711 + 313 + 382));
    expect(report.rows.filter((row) => row.initial).map((row) => row.name).sort()).toEqual(['app', 'index']);
  });

  it('fails a chunk over the limit that is not on the allow-list', () => {
    const report = analyse([...GOOD, chunk('docx-AAAAAAAA.js', 501)], INITIAL, budget);
    expect(report.problems).toEqual([expect.stringContaining('docx-AAAAAAAA.js is 501.0 kB')]);
    expect(report.problems[0]).toContain('not on the allow-list');
  });

  it('accepts a chunk of exactly the limit', () => {
    expect(analyse([...GOOD, chunk('docx-AAAAAAAA.js', 500)], INITIAL, budget).problems).toEqual([]);
  });

  it('fails fontkit over 750 kB, and an allow-listed chunk over its own cap', () => {
    const fontkit = analyse([chunk('index-aVYiHL54.js', 400), chunk('app-9gel3XQa.js', 600), chunk('fontkit.es-B1-xruQ9.js', 751)], INITIAL, budget);
    expect(fontkit.problems).toEqual([expect.stringContaining('fontkit.es-B1-xruQ9.js is 751.0 kB, over its allow-list cap of 750.0 kB')]);
    const app = analyse([chunk('index-aVYiHL54.js', 400), chunk('app-9gel3XQa.js', 641), chunk('fontkit.es-B1-xruQ9.js', 711)], INITIAL, budget);
    expect(app.problems).toEqual([expect.stringContaining('app-9gel3XQa.js is 641.0 kB, over its allow-list cap of 640.0 kB')]);
  });

  it('fails an allow-list entry that no longer needs to be there', () => {
    const small = [chunk('index-aVYiHL54.js', 400), chunk('app-9gel3XQa.js', 480), chunk('fontkit.es-B1-xruQ9.js', 711)];
    expect(analyse(small, INITIAL, budget).problems).toEqual([expect.stringContaining('"app" is on the allow-list but its chunk is 480.0 kB')]);
    const gone = [chunk('index-aVYiHL54.js', 400), chunk('fontkit.es-B1-xruQ9.js', 711)];
    expect(analyse(gone, ['index-aVYiHL54.js'], budget).problems).toEqual([expect.stringContaining('"app" is on the allow-list but no chunk has that name')]);
  });

  it('fails a first load over its gzip budget, and says by how much', () => {
    const report = analyse([chunk('index-aVYiHL54.js', 400, 400), chunk('app-9gel3XQa.js', 600, 301), chunk('fontkit.es-B1-xruQ9.js', 711)], INITIAL, budget);
    expect(report.problems).toEqual([expect.stringContaining('first load is 701.0 kB gzip, over the 700.0 kB budget')]);
  });

  it('counts only the chunks index.html loads as the first load', () => {
    const report = analyse([...GOOD, chunk('wire-QBW0gQ5L.js', 313, 900)], INITIAL, budget);
    expect(report.problems).toEqual([]);
  });

  it('fails all JS over its ceiling', () => {
    const extra = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => chunk(`${id}-AAAAAAAA.js`, 499));
    const report = analyse([...GOOD, ...extra], INITIAL, budget);
    expect(report.problems).toEqual([expect.stringContaining('all JS is 5400.0 kB, over the 5000.0 kB ceiling')]);
  });

  it('fails a first-load file that is not in the build', () => {
    const report = analyse(GOOD, [...INITIAL, 'missing-AAAAAAAA.js'], budget);
    expect(report.problems).toEqual([expect.stringContaining('index.html loads missing-AAAAAAAA.js, which is not in the build')]);
  });
});

describe('renderReport', () => {
  it('prints a table of chunks, largest first, with raw and gzip sizes, and says what it found', () => {
    const lines = renderReport(analyse(GOOD, INITIAL, budget)).split('\n');
    expect(lines[0]).toMatch(/^chunk\s+raw kB\s+gzip kB\s+loads$/);
    expect(lines[1]).toMatch(/^fontkit\.es-B1-xruQ9\.js\s+711\.0\s+237\.0\s+on use \(cap 750\.0\)$/);
    expect(lines.some((line) => line.startsWith('first load'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('bundle size: ok');
  });

  it('lists each problem, and says the check failed', () => {
    const text = renderReport(analyse([...GOOD, chunk('docx-AAAAAAAA.js', 501)], INITIAL, budget));
    expect(text).toContain('bundle size: FAILED');
    expect(text).toContain('docx-AAAAAAAA.js is 501.0 kB');
  });
});

describe('readBuild', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads index.html and the JS under assets, and ignores everything else there', () => {
    const dist = mkdtempSync(join(tmpdir(), 'caotang-bundle-'));
    dirs.push(dist);
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<script type="module" src="/assets/index-aVYiHL54.js"></script>');
    writeFileSync(join(dist, 'assets', 'index-aVYiHL54.js'), 'x'.repeat(2000));
    writeFileSync(join(dist, 'assets', 'index-aVYiHL54.js.map'), '{}');
    writeFileSync(join(dist, 'assets', 'index-DVvcK7w0.css'), 'a{}');
    const build = readBuild(dist);
    expect(build.initial).toEqual(['index-aVYiHL54.js']);
    expect(build.chunks).toHaveLength(1);
    expect(build.chunks[0]).toMatchObject({ file: 'index-aVYiHL54.js', bytes: 2000 });
    expect(build.chunks[0]?.gzip).toBeGreaterThan(0);
    expect(build.chunks[0]?.gzip).toBeLessThan(200);
  });

  it('fails and says to build first when there is no build', () => {
    expect(() => readBuild(join(tmpdir(), 'caotang-no-such-build'))).toThrow(/pnpm build/);
  });
});

describe('BUDGET', () => {
  it('holds the two limits the owner fixed: 500 kB per chunk, and fontkit up to 750 kB', () => {
    expect(BUDGET.chunkLimit).toBe(500_000);
    expect(BUDGET.allow['fontkit.es']).toBe(750_000);
  });

  it('has a ceiling for the first load and for all JS', () => {
    expect(BUDGET.initialGzip).toBeGreaterThan(0);
    expect(BUDGET.totalJs).toBeGreaterThan(BUDGET.chunkLimit);
  });
});
