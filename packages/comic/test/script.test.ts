import { describe, expect, it } from 'vitest';
import { parseComicScript, parseNumberToken, renderMessage, SCRIPT_MODIFIERS } from '../src/index.js';

const one = (body: string) => {
  const parsed = parseComicScript(body);
  const line = parsed.pages[0]?.panels[0]?.lines[0];
  if (line === undefined) throw new Error('no lettering line parsed');
  return line;
};

describe('page headers', () => {
  it.each([
    ['PAGE ONE', 1],
    ['Page 1', 1],
    ['PAGE 1 (five panels)', 1],
    ['Page Twenty-One', 21],
    ['page 12:', 12],
    ['## PAGE 3', 3],
    ['**PAGE FOUR**', 4],
  ])('reads %s', (header, number) => {
    const parsed = parseComicScript(`${header}\n\nPANEL 1\n`);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]?.number).toBe(number);
  });

  it('reads the panel count a header promises, in digits or words', () => {
    expect(parseComicScript('PAGE 1 (five panels)').pages[0]?.declaredPanelCount).toBe(5);
    expect(parseComicScript('PAGE 1 (5 PANELS)').pages[0]?.declaredPanelCount).toBe(5);
    expect(parseComicScript('PAGE 1 (1 panel)').pages[0]?.declaredPanelCount).toBe(1);
    expect(parseComicScript('PAGE 1 (splash)').pages[0]?.declaredPanelCount).toBeUndefined();
    expect(parseComicScript('PAGE 1').pages[0]?.declaredPanelCount).toBeUndefined();
  });

  it('does not take prose for a page header', () => {
    expect(parseComicScript('Page turn here is a reveal.\nPAGE ONE').pages).toHaveLength(1);
    expect(parseComicScript('PAGE BREAK').pages).toHaveLength(0);
  });

  it('parses number words and digits', () => {
    expect(parseNumberToken('seven')).toBe(7);
    expect(parseNumberToken('NINETEEN')).toBe(19);
    expect(parseNumberToken('forty-two')).toBe(42);
    expect(parseNumberToken('thirty')).toBe(30);
    expect(parseNumberToken('banana')).toBeUndefined();
    expect(parseNumberToken('twenty-twenty')).toBeUndefined();
  });
});

describe('panel headers', () => {
  it.each([
    ['PANEL 1', '1'],
    ['Panel 2:', '2'],
    ['1.)', '1'],
    ['3)', '3'],
    ['PANEL A', 'A'],
    ['Panel B.', 'B'],
    ['PANEL ONE', 'ONE'],
  ])('reads %s', (header, label) => {
    const page = parseComicScript(`PAGE 1\n${header}\n`).pages[0];
    expect(page?.panels).toHaveLength(1);
    expect(page?.panels[0]?.label).toBe(label);
    expect(page?.panels[0]?.implicit).toBe(false);
  });

  it('keeps the description on the header line and on the lines under it', () => {
    const page = parseComicScript('PAGE 1\nPANEL 1: Wide shot of the harbour.\nGulls wheel overhead.\n\nPANEL 2 - Close on Mara.').pages[0];
    expect(page?.panels[0]?.description).toBe('Wide shot of the harbour.\nGulls wheel overhead.');
    expect(page?.panels[1]?.description).toBe('Close on Mara.');
  });

  it('numbers panels by position whatever their labels say', () => {
    const page = parseComicScript('PAGE 1\nPANEL A\nPANEL B\nPANEL C').pages[0];
    expect(page?.panels.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it('does not take a lower-case word for a letter label', () => {
    expect(parseComicScript('PAGE 1\nPanel a lot of rain falls.').pages[0]?.panels).toHaveLength(0);
  });

  it('puts description before the first panel on the page', () => {
    const page = parseComicScript('PAGE 1\nA quiet street at dawn.\nPANEL 1').pages[0];
    expect(page?.description).toBe('A quiet street at dawn.');
  });

  it('makes an implicit panel for lettering with no panel header', () => {
    const page = parseComicScript('PAGE 1\n\nMARA: Hello.').pages[0];
    expect(page?.panels).toHaveLength(1);
    expect(page?.panels[0]?.implicit).toBe(true);
    expect(page?.panels[0]?.lines[0]?.text).toBe('Hello.');
  });

  it('does not parse before the first page header', () => {
    const parsed = parseComicScript('TITLE: Night Shift\nPANEL 1\nPAGE 1\nPANEL 1');
    expect(parsed.preamble).toBe('TITLE: Night Shift\nPANEL 1');
    expect(parsed.pages[0]?.panels).toHaveLength(1);
  });
});

describe('lettering lines', () => {
  it('reads NAME, CAPTION and SFX', () => {
    const body = 'PAGE 1\nPANEL 1\nMARA: Who is there?\nCAPTION: Midnight.\nSFX: KRAK';
    const lines = parseComicScript(body).pages[0]?.panels[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.speakerName, l.text])).toEqual([
      ['speech', 'MARA', 'Who is there?'],
      ['caption', undefined, 'Midnight.'],
      ['sfx', undefined, 'KRAK'],
    ]);
  });

  it('reads numbered lettering, with a dot or a bracket', () => {
    expect(one('PAGE 1\nPANEL 1\n3. MARA: Hi.').number).toBe(3);
    expect(one('PAGE 1\nPANEL 1\n3) MARA: Hi.').number).toBe(3);
    expect(one('PAGE 1\nPANEL 1\n12. CAPTION: Later.').kind).toBe('caption');
    expect(one('PAGE 1\nPANEL 1\nMARA: Hi.').number).toBeUndefined();
  });

  it('accepts a caption and sfx in any case, a speaker name only without lower case', () => {
    expect(one('PAGE 1\nPANEL 1\nCaption: Later.').kind).toBe('caption');
    expect(one('PAGE 1\nPANEL 1\nsfx: boom').kind).toBe('sfx');
    expect(parseComicScript('PAGE 1\nPANEL 1\nNote to the artist: keep it dark.').pages[0]?.panels[0]?.lines).toEqual([]);
    expect(one("PAGE 1\nPANEL 1\nMR. O'BRIEN 2: Fine.").speakerName).toBe("MR. O'BRIEN 2");
  });

  it('keeps a colon inside the dialogue', () => {
    expect(one('PAGE 1\nPANEL 1\nMARA: Three things: salt, rope, lamp.').text).toBe('Three things: salt, rope, lamp.');
  });

  it('does not mistake a panel or page header for a speaker', () => {
    const page = parseComicScript('PAGE 1\nPANEL 1: Wide shot.\nPAGE TWO:').pages;
    expect(page[0]?.panels[0]?.lines).toHaveLength(0);
    expect(page).toHaveLength(2);
  });

  it('joins continuation lines, and ends them at a blank line', () => {
    const body = 'PAGE 1\nPANEL 1\nMARA: First line\nsecond line\n  third line\n\nA description.';
    const panel = parseComicScript(body).pages[0]?.panels[0];
    expect(panel?.lines[0]?.text).toBe('First line\nsecond line\nthird line');
    expect(panel?.description).toBe('A description.');
  });

  it('lets the text start on the next line', () => {
    expect(one('PAGE 1\nPANEL 1\nMARA:\nIt is late.').text).toBe('It is late.');
  });

  it('reads an empty balloon', () => {
    expect(one('PAGE 1\nPANEL 1\nMARA:').text).toBe('');
  });

  it('records offsets that slice the body back to the line', () => {
    const body = 'PAGE 1\r\nPANEL 1\r\n  1. MARA: Hi\r\n    there.\r\n2. SFX: BOOM\r\n';
    const lines = parseComicScript(body).pages[0]?.panels[0]?.lines ?? [];
    expect(body.slice(lines[0]?.from, lines[0]?.to)).toBe('1. MARA: Hi\r\n    there.');
    expect(body.slice(lines[1]?.from, lines[1]?.to)).toBe('2. SFX: BOOM');
    expect(lines[1]?.line).toBe(5);
  });

  it('keeps Han and right-to-left dialogue as written', () => {
    const body = 'PAGE 1\nPANEL 1\n玛拉: 你好，世界！\nسارة: مرحبا بالعالم';
    const lines = parseComicScript(body).pages[0]?.panels[0]?.lines ?? [];
    expect(lines.map((l) => [l.speakerName, l.text])).toEqual([
      ['玛拉', '你好，世界！'],
      ['سارة', 'مرحبا بالعالم'],
    ]);
  });
});

describe('modifiers', () => {
  it.each([
    ['OFF', 'speech', true],
    ['OP', 'speech', true],
    ['off', 'speech', true],
    ['WHISPER', 'whisper', false],
    ['BURST', 'shout', false],
    ['THOUGHT', 'thought', false],
    ['RADIO', 'radio', false],
    ['ELEC', 'radio', false],
  ] as const)('maps (%s)', (word, kind, offPanel) => {
    const line = one(`PAGE 1\nPANEL 1\nMARA (${word}): Hello.`);
    expect(line.kind).toBe(kind);
    expect(line.offPanel).toBe(offPanel);
    expect(line.modifiers).toEqual([word.toUpperCase()]);
    expect(line.text).toBe('Hello.');
    expect(line.unknownModifiers).toEqual([]);
  });

  it('covers every word the table lists', () => {
    expect(Object.keys(SCRIPT_MODIFIERS).sort()).toEqual(['BURST', 'ELEC', 'OFF', 'OP', 'RADIO', 'THOUGHT', 'WHISPER']);
  });

  it('combines modifiers in one group or several', () => {
    for (const written of ['MARA (OFF, WHISPER)', 'MARA (OFF) (WHISPER)', 'MARA (WHISPER, OP)']) {
      const line = one(`PAGE 1\nPANEL 1\n${written}: Psst.`);
      expect(line.kind).toBe('whisper');
      expect(line.offPanel).toBe(true);
    }
  });

  it('keeps an unknown modifier as text in the balloon', () => {
    const line = one('PAGE 1\nPANEL 1\nMARA (V.O.): Hello.');
    expect(line.kind).toBe('speech');
    expect(line.text).toBe('(V.O.) Hello.');
    expect(line.unknownModifiers).toEqual(['V.O.']);
    expect(one('PAGE 1\nPANEL 1\nMARA (mumbling, OFF): Hm.')).toMatchObject({ text: '(mumbling) Hm.', offPanel: true });
  });

  it('keeps a second kind modifier as text, and a kind modifier on a caption', () => {
    expect(one('PAGE 1\nPANEL 1\nMARA (WHISPER, BURST): Hm.')).toMatchObject({ kind: 'whisper', text: '(BURST) Hm.' });
    expect(one('PAGE 1\nPANEL 1\nCAPTION (RADIO): Hm.')).toMatchObject({ kind: 'caption', text: '(RADIO) Hm.' });
    expect(one('PAGE 1\nPANEL 1\nCAPTION (OFF): Hm.')).toMatchObject({ kind: 'caption', offPanel: true });
  });

  it('does not read a parenthesis after the colon as a modifier', () => {
    expect(one('PAGE 1\nPANEL 1\nMARA: (WHISPER) hello').kind).toBe('speech');
  });
});

describe('panel count check', () => {
  it('reports a mismatch as a soft finding and still returns every page and panel', () => {
    const parsed = parseComicScript('PAGE 1 (five panels)\nPANEL 1\nPANEL 2\nPANEL 3\nPANEL 4\n\nPAGE 2 (two panels)\nPANEL 1\nPANEL 2');
    expect(parsed.pages.map((p) => p.panels.length)).toEqual([4, 2]);
    expect(parsed.findings).toHaveLength(1);
    const [finding] = parsed.findings;
    expect(finding).toMatchObject({ code: 'panelCountMismatch', pageNumber: 1, declared: 5, found: 4 });
    expect(renderMessage(finding!.message)).toBe(
      'Page 1 says it has 5 panels, but 4 were found. Fix the number in the page header, or add or remove a panel.',
    );
    expect(finding?.message.id).toBe('comic.script.panelCountMismatch');
  });

  it('reports nothing when the count matches or none is declared', () => {
    expect(parseComicScript('PAGE 1 (2 panels)\nPANEL 1\n1.)').findings).toEqual([]);
    expect(parseComicScript('PAGE 1\nPANEL 1').findings).toEqual([]);
  });

  it('counts an implied panel and reports a declared panel with none found', () => {
    expect(parseComicScript('PAGE 1 (1 panel)\nMARA: Hi.').findings).toEqual([]);
    expect(parseComicScript('PAGE 1 (3 panels)').findings).toHaveLength(1);
  });
});

describe('whole scripts', () => {
  it('parses a script written in mixed spellings', () => {
    const body = [
      'PAGE ONE (three panels)',
      '',
      'PANEL 1',
      'Establishing shot.',
      '1. CAPTION: The harbour, 6 a.m.',
      '',
      'Panel 2:',
      '2. MARA (OFF): Hold the line!',
      '',
      '3.)',
      '3. SFX: SPLASH',
      '',
      'PAGE 2',
      'PANEL A',
      'JONAH (THOUGHT): She never listens.',
    ].join('\n');
    const parsed = parseComicScript(body);
    expect(parsed.findings).toEqual([]);
    expect(parsed.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(parsed.pages[0]?.panels.map((p) => p.lines.map((l) => l.kind))).toEqual([['caption'], ['speech'], ['sfx']]);
    expect(parsed.pages[1]?.panels[0]?.lines[0]).toMatchObject({ kind: 'thought', speakerName: 'JONAH' });
  });

  it('returns no pages for an empty script', () => {
    expect(parseComicScript('')).toEqual({ pages: [], preamble: '', findings: [] });
  });
});
