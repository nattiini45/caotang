/**
 * The Highland reader (issue #284): a `.highland` package imports like its exported `.fountain`, the title comes from
 * info.json, the assets ride along, and the bin, revisions and planning metadata are listed as losses, never dropped.
 * The fixtures are honest stored zips written byte by byte, so the test needs no zip writer of its own.
 */

import { describe, expect, it } from 'vitest';

import { importFountainScript } from '@caotang/screenplay';

import { readHighland } from '../src/index.js';

const enc = new TextEncoder();

/** A stored (method 0) zip with honest headers and the UTF-8 name flag; CRCs are zero, which fflate's unzipSync does not check. */
function storedZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [name, value] of entries) {
    const data = typeof value === 'string' ? enc.encode(value) : value;
    const nb = enc.encode(name);
    const local = new Uint8Array(30 + nb.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30);
    const head = new Uint8Array(46 + nb.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    head.set(nb, 46);
    parts.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const FOUNTAIN = ['# Act One', '', 'INT. LIGHTHOUSE - NIGHT', '', 'The boat came in with the tide. Nobody was on it.', '', 'EXT. SHORE - DAY', '', 'A figure walks up the beach.'].join('\n');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function packageZip(extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  return storedZip({
    'text.fountain': FOUNTAIN,
    'info.json': JSON.stringify({ title: 'The Lighthouse Keeper', sprints: [{ name: 'Draft' }], milestones: [{ name: 'Lock' }] }),
    'assets/lighthouse.png': PNG,
    'bin/scratch.bin': 'binary residue',
    'revisions/current.json': '{"rev":1}',
    ...extra,
  });
}

describe('readHighland', () => {
  it('imports a package like its exported .fountain, with the info.json title, the assets and the losses', async () => {
    const result = await readHighland(packageZip(), 'The Lighthouse Keeper.highland');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.script).toEqual(importFountainScript(FOUNTAIN));
    expect(result.value.title).toBe('The Lighthouse Keeper');
    expect(result.value.assets).toEqual([{ path: 'assets/lighthouse.png', bytes: PNG }]);
    expect(result.value.losses).toEqual([
      'bin/ (1 file) not imported',
      'revisions/ (1 file) not imported',
      'sprints and milestones not imported',
    ]);
  });

  it('degrades Highland highlight and strikethrough to plain text and says so', async () => {
    const marked = 'INT. ROOM - DAY\n\nShe +really+ meant it, ~~every word~~.';
    const result = await readHighland(storedZip({ 'text.fountain': marked }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value.script.nodes[0];
    expect(scene?.kind).toBe('scene');
    expect(scene?.kind === 'scene' ? scene.body : '').toContain('She really meant it, every word.');
    expect(result.value.notices).toContain('Highland highlight and strikethrough markers were kept as plain text');
  });

  it('falls back to text.markdown then text.txt, read as Fountain with a notice', async () => {
    const markdown = await readHighland(storedZip({ 'text.markdown': FOUNTAIN }));
    expect(markdown.ok).toBe(true);
    if (markdown.ok) {
      expect(markdown.value.script).toEqual(importFountainScript(FOUNTAIN));
      expect(markdown.value.notices).toContain('text.markdown was read as Fountain; a Markdown reader is not built yet');
    }
    const txt = await readHighland(storedZip({ 'text.txt': FOUNTAIN }));
    expect(txt.ok).toBe(true);
    if (txt.ok) expect(txt.value.notices).toContain('text.txt was read as Fountain; a Markdown reader is not built yet');
  });

  it('refuses a package with no script file', async () => {
    const result = await readHighland(storedZip({ 'info.json': '{"title":"X"}' }));
    expect(result).toEqual({ ok: false, error: { code: 'no-script', message: expect.any(String) } });
  });

  it('refuses bytes that are not a zip', async () => {
    const result = await readHighland(enc.encode('this is not a zip'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-a-zip');
  });

  it('tolerates malformed info.json and falls back to the file name for the title', async () => {
    const result = await readHighland(storedZip({ 'text.fountain': FOUNTAIN, 'info.json': '{not json' }), 'My Story.highland');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('My Story');
    expect(result.value.notices).toContain('info.json could not be read; the title falls back to the script');
  });

  it('takes the Fountain title page when info.json has no title', async () => {
    const withTitlePage = `Title: From the Title Page\n\n${FOUNTAIN}`;
    const result = await readHighland(storedZip({ 'text.fountain': withTitlePage, 'info.json': '{}' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe('From the Title Page');
  });

  it('names every other file in the package and an empty asset, so nothing is dropped silently', async () => {
    const result = await readHighland(
      packageZip({ 'notes.md': 'a writer note', 'styles/custom.css': 'body{}', 'text.markdown': FOUNTAIN, 'assets/empty.png': new Uint8Array(0) }),
      'x.highland',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets).toEqual([{ path: 'assets/lighthouse.png', bytes: PNG }]);
    expect(result.value.losses).toContain('assets/ (1 empty file) not imported');
    expect(result.value.losses).toContain('notes.md, styles/custom.css, text.markdown not imported');
  });

  it('names twenty other files and counts the rest', async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) extra[`notes/n${i}.md`] = 'a note';
    const result = await readHighland(packageZip(extra), 'x.highland');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.value.losses.find((loss) => loss.startsWith('notes/'));
    expect(line).toBeDefined();
    expect(line).toContain('and 5 more files not imported');
    expect(line?.split(', ')).toHaveLength(20);
  });

  it('says nothing extra for a package that carries only what it imports', async () => {
    const result = await readHighland(storedZip({ 'text.fountain': FOUNTAIN, 'info.json': '{"title":"X"}', 'assets/a.png': PNG }), 'x.highland');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.losses).toEqual([]);
  });
});
