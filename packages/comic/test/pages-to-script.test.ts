import { describe, expect, it } from 'vitest';
import { parseComicScript, scriptFromPages, scriptSpeakerName, type ComicPage } from '../src/index.js';
import { balloon, page, panel } from './fixtures.js';

const names: Record<string, string> = { c_MARA: 'Mara', c_JONAH: 'Jonah', c_HAN: '玛拉', c_AR: 'سارة' };
const speakerName = (id: string): string | undefined => names[id];

const book: ComicPage[] = [
  page([
    panel('p1', [
      balloon('b1', 'Who is there?', { speaker: 'c_MARA' }),
      balloon('b2', 'Midnight.', { kind: 'caption' }),
      balloon('b3', 'KRAK', { kind: 'sfx' }),
    ]),
    panel('p2', [
      balloon('b4', 'Hold the line!', { speaker: 'c_MARA', offPanel: true }),
      balloon('b5', 'She never listens.', { kind: 'thought', speaker: 'c_JONAH' }),
      balloon('b6', 'Psst.', { kind: 'whisper', speaker: 'c_MARA', offPanel: true }),
      balloon('b7', 'NOW!', { kind: 'shout', speaker: 'c_JONAH' }),
      balloon('b8', 'Come in, over.', { kind: 'radio', speaker: 'c_JONAH' }),
    ]),
    panel('p3'),
  ]),
  page([panel('p4', [balloon('b9', '你好，世界！', { speaker: 'c_HAN' }), balloon('b10', 'مرحبا بالعالم', { speaker: 'c_AR' })])]),
  page([]),
  page([panel('p5', [balloon('b11', 'Line one\nline two\nline three', { speaker: 'c_MARA' })])]),
];

const flatten = (pages: ComicPage[]) =>
  pages.map((p) => p.panels.map((pn) => pn.balloons.map((b) => [b.kind, b.text, b.offPanel === true])));

describe('scriptFromPages', () => {
  const generated = scriptFromPages(
    book.map((p, i) => ({ number: i + 1, page: p })),
    { speakerName },
  );
  const parsed = parseComicScript(generated.body);

  it('writes a script the parser reads back in the same order with the same text', () => {
    expect(parsed.findings).toEqual([]);
    expect(parsed.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    const back = parsed.pages.map((p) =>
      p.panels.map((pn) => pn.lines.map((l) => [l.kind, l.text, l.offPanel])),
    );
    expect(back).toEqual(flatten(book));
  });

  it('writes the page header with its panel count, and none for an empty page', () => {
    expect(generated.body).toContain('PAGE 1 (3 panels)');
    expect(generated.body).toContain('PAGE 2 (1 panel)');
    expect(generated.body).toMatch(/PAGE 3\n/);
    expect(parsed.pages[0]?.declaredPanelCount).toBe(3);
    expect(parsed.pages[2]?.declaredPanelCount).toBeUndefined();
  });

  it('keeps a panel with no balloons as a panel', () => {
    expect(parsed.pages[0]?.panels[2]?.lines).toEqual([]);
    expect(parsed.pages[0]?.panels).toHaveLength(3);
  });

  it('writes speakers from the codex names, upper-cased', () => {
    const speakers = parsed.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => l.speakerName)));
    expect(speakers).toContain('MARA');
    expect(speakers).toContain('JONAH');
    expect(speakers).toContain('玛拉');
    expect(speakers).toContain('سارة');
  });

  it('numbers the lettering on each page and can leave it out', () => {
    expect(generated.body).toContain('1. MARA: Who is there?');
    expect(generated.body).toContain('8. JONAH (RADIO): Come in, over.');
    expect(generated.body).toMatch(/PAGE 4[^]*1\. MARA: Line one/);
    const plain = scriptFromPages([{ page: book[0] as ComicPage }], { speakerName, numberLines: false });
    expect(plain.body).toContain('\nMARA: Who is there?');
    expect(parseComicScript(plain.body).pages[0]?.panels[0]?.lines[0]?.number).toBeUndefined();
  });

  it('indents the continuation of a multi-line balloon so it stays one balloon', () => {
    expect(generated.body).toContain('1. MARA: Line one\n  line two\n  line three');
    expect(parsed.pages[3]?.panels[0]?.lines[0]?.text).toBe('Line one\nline two\nline three');
  });

  it('records offsets a fresh anchor can be captured from', () => {
    expect(generated.lines).toHaveLength(11);
    const second = generated.lines[1]!;
    expect(second).toMatchObject({ pageIndex: 0, panelId: 'p1', balloonId: 'b2' });
    expect(generated.body.slice(second.from, second.to)).toBe('2. CAPTION: Midnight.');
    const lastLine = generated.lines.at(-1)!;
    expect(generated.body.slice(lastLine.from, lastLine.to)).toBe('1. MARA: Line one\n  line two\n  line three');
    const flat = parsed.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    expect(flat.map((l) => [l.from, l.to])).toEqual(generated.lines.map((l) => [l.from, l.to]));
  });

  it('writes the page number it is given, not its position', () => {
    const out = scriptFromPages([{ number: 7, page: book[0] as ComicPage }], { speakerName });
    expect(parseComicScript(out.body).pages[0]?.number).toBe(7);
  });

  it('round-trips an unknown modifier that was kept as text', () => {
    const first = parseComicScript('PAGE 1\nPANEL 1\n1. MARA (V.O.): Hello.');
    const line = first.pages[0]?.panels[0]?.lines[0];
    const pageBack = page([panel('p', [balloon('b', line?.text ?? '', { speaker: 'c_MARA' })])]);
    const again = parseComicScript(scriptFromPages([{ page: pageBack }], { speakerName }).body);
    expect(again.pages[0]?.panels[0]?.lines[0]?.text).toBe('(V.O.) Hello.');
  });

  it('is stable: a script written from parsed pages parses to the same lines', () => {
    const once = parseComicScript(generated.body);
    const rebuilt: ComicPage[] = once.pages.map((p) =>
      page(
        p.panels.map((pn, i) =>
          panel(
            `p${p.number}-${i}`,
            pn.lines.map((l, j) =>
              balloon(`b${p.number}-${i}-${j}`, l.text, {
                kind: l.kind,
                ...(l.offPanel ? { offPanel: true as const } : {}),
                ...(l.speakerName === undefined ? {} : { speaker: l.speakerName }),
              }),
            ),
          ),
        ),
      ),
    );
    const twice = parseComicScript(
      scriptFromPages(
        rebuilt.map((p, i) => ({ number: i + 1, page: p })),
        { speakerName: (id) => id },
      ).body,
    );
    const shape = (s: typeof once) => s.pages.map((p) => p.panels.map((pn) => pn.lines.map((l) => [l.kind, l.speakerName, l.text, l.offPanel])));
    expect(shape(twice)).toEqual(shape(once));
  });

  it('falls back when a speaker cannot be named, and cleans names the grammar would misread', () => {
    const out = scriptFromPages([{ page: page([panel('p', [balloon('b', 'Hi', { speaker: 'c_UNKNOWN' }), balloon('b2', 'Yo')])]) }], {
      speakerName,
    });
    const lines = parseComicScript(out.body).pages[0]?.panels[0]?.lines ?? [];
    expect(lines.map((l) => l.speakerName)).toEqual(['VOICE', 'VOICE']);
    expect(scriptSpeakerName('Dr. Who: (II)')).toBe('DR. WHO II');
    expect(scriptSpeakerName('   ')).toBe('VOICE');
    expect(scriptSpeakerName('123', 'X')).toBe('X');
  });

  it('writes an unknown balloon kind as speech', () => {
    const out = scriptFromPages([{ page: page([panel('p', [balloon('b', 'hm', { kind: 'telepathy', speaker: 'c_MARA' })])]) }], {
      speakerName,
    });
    expect(parseComicScript(out.body).pages[0]?.panels[0]?.lines[0]).toMatchObject({ kind: 'speech', text: 'hm' });
  });

  it('writes an empty script for no pages', () => {
    expect(scriptFromPages([])).toEqual({ body: '', lines: [] });
  });
});
