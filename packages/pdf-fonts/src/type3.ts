/**
 * The colour emoji font of a PDF: Type 3 fonts whose glyphs are the vector pictures of `@caotang/font-noto-color-emoji`
 * ([screenplay.md §5.3](../../../docs/architecture/screenplay.md), [storyboard.md §6](../../../docs/architecture/storyboard.md)).
 *
 * A Type 3 font is a simple font: one-byte codes, so a font holds at most {@link TYPE3_CODES} distinct emoji and a document with
 * more gets several. Each emoji is one code with its own glyph procedure, whatever the emoji is made of (👍🏽, 🏳️‍🌈, 👨‍👩‍👧), and the
 * ToUnicode map gives the whole sequence back, as the Type 0 fonts of cid-font.ts do for the monochrome font.
 *
 * The glyph procedures are the asset's operator strings, written as they are after `w 0 d0` (a coloured glyph: the font does not
 * take the text colour). Nothing the writer is given by a document is put into one: the text of an emoji goes to the ToUnicode map,
 * hex-encoded, and nowhere else. The shapes, shadings, graphics states and soft masks a glyph names are the asset's pool
 * entries; they are written once however many glyphs and fonts use them.
 *
 * Like cid-font.ts, the writer knows no PDF library: {@link type3Objects} gives dictionaries and streams that refer to each other
 * by their index in the list.
 */

import { toUnicodeCMap, type PdfObject, type PdfValue } from './cid-font.js';

/** The codes of a Type 3 font that hold a glyph: 1 to 255 (code 0 stays free). */
export const TYPE3_CODES = 255;

/** One emoji of a Type 3 font. */
export interface Type3Glyph {
  /** The text a reader gets back when it copies the emoji: the whole cluster. */
  readonly text: string;
  /** The advance the PDF states, in thousandths of the font size. */
  readonly width: number;
  /** The operators that draw the emoji, in the 1000-unit em, from the asset. */
  readonly content: string;
  /** The pool entries the operators name (`s12`, `g3`, `m7`, `p40`). */
  readonly ids: readonly string[];
  /** The glyph's bounding box in the 1000-unit em. */
  readonly bbox: readonly [number, number, number, number];
}

/** What the writer reads of the asset's pool: the kind of an entry (its first letter) and its text. */
export type Type3Pool = (id: string) => string;

/** Where a font of the list is: its object, and how many glyphs it holds. */
export interface Type3Font {
  /** The object that is the font dictionary, which a page's font resource points at. */
  readonly object: number;
  readonly first: number;
  readonly count: number;
}

export interface Type3Fonts {
  readonly objects: readonly PdfObject[];
  /** One entry for each {@link TYPE3_CODES} glyphs, in order; glyph `i` is code `i % 255 + 1` of font `floor(i / 255)`. */
  readonly fonts: readonly Type3Font[];
}

const name = (value: string): PdfValue => ({ name: value });
const ref = (index: number): PdfValue => ({ ref: index });
const raw = (text: string): PdfValue => ({ raw: text });

/** The code of the glyph at an index of the list, and the font it is in. */
export function type3Place(index: number): { readonly font: number; readonly code: number } {
  return { font: Math.floor(index / TYPE3_CODES), code: (index % TYPE3_CODES) + 1 };
}

/** The box a form XObject of the pool is clipped to: wide enough for any glyph. */
const FORM_BOX: PdfValue = [-1000, -1000, 3000, 3000];

/** The name a pool entry has in a font's resources: its id. */
const RESOURCE_KINDS = { p: 'XObject', s: 'Shading', g: 'ExtGState', m: 'ExtGState' } as const;

/**
 * The objects of the Type 3 fonts for a list of glyphs: the font dictionaries first (object 0 is the first font), then each
 * font's glyph procedures and ToUnicode map, then the pool entries the glyphs use, once each.
 */
export function type3Objects(glyphs: readonly Type3Glyph[], pool: Type3Pool): Type3Fonts {
  const fontCount = Math.ceil(glyphs.length / TYPE3_CODES);
  const fontObjects: PdfObject[] = [];
  const poolObject = new Map<string, { readonly resource: PdfValue }>();
  const poolObjects: PdfObject[] = [];
  const fonts: Type3Font[] = [];

  // The pool objects follow every font's own objects, so their indexes are known once those are counted.
  const ownObjects = fontCount + glyphs.length + fontCount;
  const poolIndex = (): number => ownObjects + poolObjects.length;

  const resourceOf = (id: string): PdfValue => {
    const known = poolObject.get(id);
    if (known !== undefined) return known.resource;
    const kind = id.charAt(0);
    const text = pool(id);
    let resource: PdfValue;
    if (kind === 'g') {
      resource = raw(text);
    } else if (kind === 'p') {
      resource = ref(poolIndex());
      poolObjects.push({ dict: { Type: name('XObject'), Subtype: name('Form'), BBox: FORM_BOX }, stream: text });
    } else if (kind === 's') {
      resource = ref(poolIndex());
      poolObjects.push({ dict: {}, raw: text });
    } else if (kind === 'm') {
      // A soft mask: a form that draws the gray shading of the opacities, and the graphics state that uses it.
      const [extras = '', shading = ''] = text.split('|');
      const form = poolIndex();
      poolObjects.push({
        dict: {
          Type: name('XObject'),
          Subtype: name('Form'),
          BBox: FORM_BOX,
          Group: raw('<< /S /Transparency /CS /DeviceGray >>'),
          Resources: raw(`<< /Shading << /M ${shading.trim()} >> >>`),
        },
        stream: '/M sh',
      });
      resource = ref(poolIndex());
      const blend = /\/BM\s+\/([A-Za-z]+)/.exec(extras)?.[1];
      poolObjects.push({
        dict: {
          Type: name('ExtGState'),
          SMask: { dict: { Type: name('Mask'), S: name('Luminosity'), G: ref(form) } },
          ...(blend === undefined ? {} : { BM: name(blend) }),
        },
      });
    } else {
      throw new Error(`the colour emoji asset names a pool entry of an unknown kind (${id})`);
    }
    poolObject.set(id, { resource });
    return resource;
  };

  const charProcs: PdfObject[] = [];
  const toUnicode: PdfObject[] = [];
  for (let f = 0; f < fontCount; f += 1) {
    const slice = glyphs.slice(f * TYPE3_CODES, (f + 1) * TYPE3_CODES);
    const procBase = fontCount + charProcs.length;
    const procs: { [key: string]: PdfValue } = {};
    const resources: { [kind: string]: { [id: string]: PdfValue } } = {};
    slice.forEach((glyph, i) => {
      procs[`c${i + 1}`] = ref(procBase + i);
      charProcs.push({ dict: {}, stream: `${glyph.width} 0 d0\n${glyph.content}` });
      for (const id of glyph.ids) {
        const kind = RESOURCE_KINDS[id.charAt(0) as keyof typeof RESOURCE_KINDS];
        (resources[kind] ??= {})[id] = resourceOf(id);
      }
    });
    const map = fontCount + glyphs.length + f;
    toUnicode.push({ dict: {}, stream: toUnicodeCMap(slice.map((glyph, i) => ({ gid: 0, width: glyph.width, text: glyph.text, cid: i + 1 })), 1) });
    const box = [
      Math.min(0, ...slice.map((glyph) => glyph.bbox[0])),
      Math.min(0, ...slice.map((glyph) => glyph.bbox[1])),
      Math.max(0, ...slice.map((glyph) => glyph.bbox[2])),
      Math.max(0, ...slice.map((glyph) => glyph.bbox[3])),
    ];
    const dict = {
      Type: name('Font'),
      Subtype: name('Type3'),
      FontBBox: box,
      FontMatrix: raw('[0.001 0 0 0.001 0 0]'),
      CharProcs: { dict: procs },
      Encoding: { dict: { Type: name('Encoding'), Differences: [1, ...slice.map((_, i) => name(`c${i + 1}`))] } },
      FirstChar: 1,
      LastChar: slice.length,
      Widths: slice.map((glyph) => glyph.width),
      Resources: {
        dict: Object.fromEntries(
          Object.entries(resources).map(([kind, entries]): [string, PdfValue] => [kind, { dict: entries }]),
        ),
      },
      ToUnicode: ref(map),
    };
    fontObjects.push({ dict });
    fonts.push({ object: f, first: f * TYPE3_CODES, count: slice.length });
  }
  return { objects: [...fontObjects, ...charProcs, ...toUnicode, ...poolObjects], fonts };
}
