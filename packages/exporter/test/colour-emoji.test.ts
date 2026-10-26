/**
 * Colour emoji in the contact-sheet PDF and the screenplay PDF compiled through the exporter (`colourEmoji`, screenplay.md §5.3,
 * storyboard.md §6): each format's default, an explicit value winning, the file the option off writes byte for byte as it was before
 * colour emoji existed, the text a reader copies out of a colour file, the fallback to the monochrome font per emoji and for the
 * whole file, and the size an emoji adds.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { FontLoader } from '@caotang/pdf-fonts';
import { loadCjkFontInNode, loadColourEmojiInNode, loadEmojiFontInNode } from '@caotang/pdf-fonts/node-loader';
import type { ProjectState } from '@caotang/store';
import { addShotNode } from '@caotang/storyboard';
import { renderMedia } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { MEDIA_IDS, OPENED, makeMediaProject } from './media-fixture.js';

type Format = 'contact-sheet-pdf' | 'pdf';

/** What a compile is given: the colour file's loader, and whether the host has the monochrome font. */
interface Rig {
  readonly state: ProjectState;
  readonly colour?: FontLoader;
}

function rig(state: ProjectState, loaders: { colour?: FontLoader } = {}): Rig {
  return { state, ...(loaders.colour === undefined ? {} : { colour: loaders.colour }) };
}

function withAction(action: string): ProjectState {
  const state = makeMediaProject();
  addShotNode(state, { parentId: MEDIA_IDS.shots, title: 'World', id: 'n_WORLD00001', now: OPENED, stored: { action } });
  return state;
}

async function compile(host: Rig, format: Format, options?: { colourEmoji?: boolean }) {
  const output = renderMedia({
    state: host.state,
    format,
    includeRootIds: ['manuscript'],
    title: 'The Lighthouse Keeper',
    author: 'Ada Lovelace',
    date: '2026-10-08',
    titlePage: true,
    base: 'out',
    assets: new Map(),
    readAsset: async () => null,
    at: COMPILED_AT,
    loadFallbackFont: loadCjkFontInNode,
    loadEmojiFont: loadEmojiFontInNode,
    ...(host.colour === undefined ? {} : { loadColourEmoji: host.colour }),
    ...(options?.colourEmoji === undefined ? {} : { colourEmoji: options.colourEmoji }),
  });
  const file = output.files[0];
  if (file === undefined || file.bytes === undefined) throw new Error('no binary file');
  const rendered = await file.bytes();
  const bare = rendered instanceof Uint8Array || typeof rendered === 'string';
  const contents = bare ? rendered : rendered.contents;
  const notes = [...output.notes, ...(bare ? [] : rendered.notes)];
  return { result: { log: { notes } }, bytes: typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents) };
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const SHEET_ACTION = 'Cut 👍🏽 and 🏳️‍🌈 and 👨‍👩‍👧 and 🇩🇪 and 1️⃣ and ❤️ and 🎬 end 草堂';
const SHEET_LATIN = 'Abeßer crosses the café © 2026';

/**
 * What the sheet and the script were written as before colour emoji existed (origin/main at the commit this feature branched from),
 * with Noto Emoji and Noto Sans Mono CJK loaded. The option off, a host with no colour file and an emoji-free document must all
 * write exactly these bytes.
 */
const GOLDEN = {
  sheetEmoji: '179ffc8a0244574b028fae3b2385ef9035f6a6ddb205fe22a9de40636cd11d51',
  sheetLatin: 'b4095e47a8e1f6aa35371d318a361261b2377a446d1d51455ddf0cf4db2b9800',
  scriptEmoji: 'a337b1320be9964b5da83bb1b0fd38a9c4645ef1a2844b937043e9f0b19efe4a',
  scriptLatin: 'd80e4bd6fe96104096cede8ddf2b19f8de6d1912cd6a24329cb9f7e6d1cd38bb',
} as const;

const CONTACT = [
  ['sheetEmoji', SHEET_ACTION],
  ['sheetLatin', SHEET_LATIN],
] as const;

describe('colour emoji off writes what the monochrome path always wrote', () => {
  for (const [name, action] of CONTACT) {
    it(`the contact sheet ${name}: a host with no colour file`, async () => {
      expect(sha((await compile(rig(withAction(action)), 'contact-sheet-pdf')).bytes)).toBe(GOLDEN[name]);
    });
    it(`the contact sheet ${name}: the option off, with the colour file loaded`, async () => {
      const { bytes } = await compile(rig(withAction(action), { colour: loadColourEmojiInNode }), 'contact-sheet-pdf', { colourEmoji: false });
      expect(sha(bytes)).toBe(GOLDEN[name]);
    });
  }

  it('the contact sheet without an emoji is the same file with colour on, and never reads the colour file', async () => {
    let reads = 0;
    const counting: FontLoader = async () => {
      reads += 1;
      return loadColourEmojiInNode();
    };
    const { bytes } = await compile(rig(withAction(SHEET_LATIN), { colour: counting }), 'contact-sheet-pdf');
    expect(sha(bytes)).toBe(GOLDEN.sheetLatin);
    expect(reads).toBe(0);
  });
});

/** The emoji a file's Type 3 fonts copy back, from their ToUnicode maps. */
async function type3Texts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const texts: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Subtype')) !== PDFName.of('Type3')) continue;
    const stream = pdf.context.lookup(object.get(PDFName.of('ToUnicode')));
    if (!(stream instanceof PDFRawStream)) continue;
    const cmap = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    for (const match of cmap.matchAll(/<[0-9A-F]{2}>\s*<([0-9A-F]{4,})>/g)) {
      const hex = match[1] ?? '';
      const units: number[] = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
      texts.push(String.fromCharCode(...units));
    }
  }
  return texts;
}

describe('the contact sheet defaults to colour', () => {
  it('draws each emoji as a Type 3 glyph whose ToUnicode entry is the whole sequence', async () => {
    const { bytes, result } = await compile(rig(withAction(SHEET_ACTION), { colour: loadColourEmojiInNode }), 'contact-sheet-pdf');
    const texts = await type3Texts(bytes);
    for (const emoji of ['👍🏽', '🏳️‍🌈', '👨‍👩‍👧', '🇩🇪', '1️⃣', '❤️', '🎬']) expect(texts, emoji).toContain(emoji);
    expect(result.log.notes).toContain('contact sheet: emoji are set in Noto Color Emoji, in colour, as vector pictures with only the emoji they use');
    // Every emoji of the sheet is in the colour set, so the monochrome font is never written.
    expect(result.log.notes.some((note) => note.includes('in monochrome'))).toBe(false);
  });

  it('is monochrome again with an explicit false, and a host with no colour file keeps its black-and-white sheet without a note', async () => {
    const off = await compile(rig(withAction(SHEET_ACTION), { colour: loadColourEmojiInNode }), 'contact-sheet-pdf', { colourEmoji: false });
    expect(await type3Texts(off.bytes)).toEqual([]);
    const bare = await compile(rig(withAction(SHEET_ACTION)), 'contact-sheet-pdf');
    expect(await type3Texts(bare.bytes)).toEqual([]);
    expect(bare.result.log.notes.some((note) => note.includes('colour'))).toBe(false);
  });

  it('says so when the recipe asks for colour and the host has no colour file', async () => {
    const { result, bytes } = await compile(rig(withAction(SHEET_ACTION)), 'contact-sheet-pdf', { colourEmoji: true });
    expect(await type3Texts(bytes)).toEqual([]);
    expect(result.log.notes).toContain('contact sheet: this compile has no colour emoji file, so the emoji are set in black and white');
  });

  it('prints the whole sheet in black and white, and says so, when the colour file cannot be read', async () => {
    const broken: FontLoader = async () => new Uint8Array([1, 2, 3]);
    const { result, bytes } = await compile(rig(withAction(SHEET_ACTION), { colour: broken }), 'contact-sheet-pdf');
    expect(await type3Texts(bytes)).toEqual([]);
    expect(result.log.notes.some((note) => note.startsWith('contact sheet: the colour emoji could not be read'))).toBe(true);
    expect(result.log.notes).toContain('contact sheet: emoji are set in Noto Emoji, in monochrome, embedded with only the glyphs they use');
  });

  it('draws an emoji the colour set lacks in the monochrome font and names it', async () => {
    // A dog with a skin tone is no emoji of Unicode: the colour set has no picture for it.
    const { result, bytes } = await compile(rig(withAction('Cut 😀 and 🐶🏽 end'), { colour: loadColourEmojiInNode }), 'contact-sheet-pdf');
    expect(await type3Texts(bytes)).toEqual(['😀']);
    expect(result.log.notes).toContain('contact sheet: Noto Color Emoji has no picture for this emoji, so it is set in black and white: 🐶🏽');
    expect(result.log.notes).toContain('contact sheet: emoji are set in Noto Emoji, in monochrome, embedded with only the glyphs they use');
  });
});

const SCRIPT = ['INT. KITCHEN - DAY', '', 'MARA', 'Fine 👍🏽 and 🏳️‍🌈 and 🇩🇪 and 👨‍👩‍👧 and ❤️ 草堂.'].join('\n');

function scriptState(body: string): ProjectState {
  const state = makeMediaProject();
  const kitchen = state.documents.get(MEDIA_IDS.kitchen);
  if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
  state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body });
  return state;
}

describe('the screenplay PDF defaults to black and white', () => {
  it('writes the file it always wrote with no option, an explicit false, and a host with no colour file', async () => {
    const plain = await compile(rig(scriptState(SCRIPT)), 'pdf');
    expect(sha(plain.bytes)).toBe(GOLDEN.scriptEmoji);
    const off = await compile(rig(scriptState(SCRIPT), { colour: loadColourEmojiInNode }), 'pdf', { colourEmoji: false });
    expect(sha(off.bytes)).toBe(GOLDEN.scriptEmoji);
    const dflt = await compile(rig(scriptState(SCRIPT), { colour: loadColourEmojiInNode }), 'pdf');
    expect(sha(dflt.bytes)).toBe(GOLDEN.scriptEmoji);
  });

  it('is unchanged for an emoji-free script with colour on', async () => {
    const latin = await compile(rig(scriptState('INT. KITCHEN - DAY\n\nMARA\nFine. Abeßer.'), { colour: loadColourEmojiInNode }), 'pdf', { colourEmoji: true });
    const base = await compile(rig(scriptState('INT. KITCHEN - DAY\n\nMARA\nFine. Abeßer.')), 'pdf');
    expect(sha(latin.bytes)).toBe(sha(base.bytes));
  });

  it('prints in colour when the option is on, with the whole sequence in ToUnicode', async () => {
    const { bytes, result } = await compile(rig(scriptState(SCRIPT), { colour: loadColourEmojiInNode }), 'pdf', { colourEmoji: true });
    const texts = await type3Texts(bytes);
    for (const emoji of ['👍🏽', '🏳️‍🌈', '🇩🇪', '👨‍👩‍👧', '❤️']) expect(texts, emoji).toContain(emoji);
    expect(result.log.notes.some((note) => note.includes('black and white'))).toBe(false);
  });

  it('says so when colour is asked for and the host has no colour file', async () => {
    const { result } = await compile(rig(scriptState(SCRIPT)), 'pdf', { colourEmoji: true });
    expect(result.log.notes).toContain('pdf: this compile has no colour emoji file, so the emoji are printed in black and white');
  });

  it('prints the whole file in black and white, and says so, when the colour file is not the shipped one', async () => {
    const wrong: FontLoader = async () => new Uint8Array([1, 2, 3, 4]);
    const { bytes, result } = await compile(rig(scriptState(SCRIPT), { colour: wrong }), 'pdf', { colourEmoji: true });
    expect(await type3Texts(bytes)).toEqual([]);
    expect(result.log.notes.some((note) => note.startsWith('pdf: the colour emoji could not be read'))).toBe(true);
    // The file is the black-and-white one.
    expect(sha(bytes)).toBe(GOLDEN.scriptEmoji);
  });
});

describe('what an emoji costs', () => {
  /** 50 distinct emoji: ten with a skin tone, five flags, five ZWJ sequences, the rest plain. */
  const FIFTY = [
    ...['👍', '👋', '🙏', '👏', '💪'].flatMap((base) => [`${base}🏽`, `${base}🏿`]),
    '🇩🇪', '🇫🇷', '🇯🇵', '🇧🇷', '🇨🇭',
    '👨‍👩‍👧', '🏳️‍🌈', '🧑‍💻', '👩‍🚀', '🐻‍❄️',
    ...['😀', '😍', '🎬', '❤️', '💙', '🔥', '⭐', '🚀', '🌈', '🍕', '🐶', '🐱', '🌳', '🌞', '🎉', '🎁', '📷', '🎵', '✅', '🟥', '🟩', '🟦', '1️⃣', '🏠', '🚗', '🌍', '🍎', '⚽', '🎸', '🌙'],
  ];

  it('adds at most 300 KB to a screenplay PDF and to a contact sheet for 50 mixed distinct emoji', async () => {
    expect(new Set(FIFTY).size).toBe(50);
    const script = `INT. KITCHEN - DAY\n\nMARA\n${FIFTY.join(' ')}`;
    const mono = await compile(rig(scriptState(script)), 'pdf');
    const colour = await compile(rig(scriptState(script), { colour: loadColourEmojiInNode }), 'pdf', { colourEmoji: true });
    const monoSheet = await compile(rig(withAction(FIFTY.join(' '))), 'contact-sheet-pdf');
    const colourSheet = await compile(rig(withAction(FIFTY.join(' ')), { colour: loadColourEmojiInNode }), 'contact-sheet-pdf');
    const report = {
      script: colour.bytes.byteLength - mono.bytes.byteLength,
      sheet: colourSheet.bytes.byteLength - monoSheet.bytes.byteLength,
    };
    expect(report.script).toBeLessThanOrEqual(300 * 1024);
    expect(report.sheet).toBeLessThanOrEqual(300 * 1024);
  });
});
