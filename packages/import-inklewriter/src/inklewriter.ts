/**
 * The Inklewriter JSON reader (issue #286). Inklewriter stories export as JSON; inkle's MIT converter (vendored as
 * inklewriter-convert.ts) turns one into Ink, and the shared whole-story planner (`planInkImport`, `@caotang/dialogue`)
 * turns that Ink into containers. This wrapper is the typed, checked surface over the vendored converter: it parses the
 * JSON, refuses anything that is not a story or whose first stitch is missing, gives a usable name to every section label
 * and flag name the converter would leave empty (reporting each rename), never lets the converter's throws escape, lists
 * the stitch images by URL (the import never fetches them; it offers no download control) and names the editor data it
 * cannot bring in. DOM-free, no eval and no network, so it runs on the main thread, in the import Worker and in Node; the
 * preview source and command wire it to the dialog later.
 */

import { planInkImport, type InkImportPlan } from '@caotang/dialogue';
import { convert } from './inklewriter-convert.js';

/** The converter's own JSON shape, taken from its signature so the vendored file stays the single source of it. */
type InklewriterJSON = Parameters<typeof convert>[0];

/** One stitch image, listed by its URL; the import never fetches it (Decision 10). */
export interface InklewriterImage {
  readonly url: string;
  readonly stitch: string;
}

/**
 * A section label or flag name the converter cannot turn into a name, and the name it was given instead. The writer sees
 * the new name in the imported dialogue, so the rename is reported rather than made silently.
 */
export interface InklewriterRename {
  readonly kind: 'section' | 'flag';
  readonly from: string;
  readonly to: string;
}

/** An Inklewriter story read: the Ink import plan, the Ink text, its title, its images, and what was left behind. */
export interface InklewriterImport {
  readonly plan: InkImportPlan;
  readonly ink: string;
  readonly title: string;
  readonly images: readonly InklewriterImage[];
  /** The parts not imported, each named for the losses report. */
  readonly losses: readonly string[];
  readonly notices: readonly string[];
  readonly renames: readonly InklewriterRename[];
}

/** A read, or a refusal flattened to a code and a message so it survives a Worker clone. */
export type InklewriterResult =
  | { readonly ok: true; readonly value: InklewriterImport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const decoder = new TextDecoder();

const refusal = (error: { readonly code: string; readonly message: string }): InklewriterResult => ({ ok: false, error });

/** The fields the converter reads before it can do anything; a JSON missing them is not an Inklewriter story. */
function isInklewriter(value: unknown): value is InklewriterJSON {
  if (value === null || typeof value !== 'object') return false;
  const data = (value as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return false;
  const stitches = (data as { stitches?: unknown }).stitches;
  return (
    typeof (value as { title?: unknown }).title === 'string' &&
    typeof (data as { initial?: unknown }).initial === 'string' &&
    stitches !== null &&
    typeof stitches === 'object'
  );
}

/** The images each stitch carries, in story order, by URL. */
function collectImages(json: InklewriterJSON): InklewriterImage[] {
  const images: InklewriterImage[] = [];
  for (const name of Object.keys(json.data.stitches)) {
    const stitch = json.data.stitches[name];
    if (stitch === undefined || !Array.isArray(stitch.content)) continue;
    for (const item of stitch.content) {
      if (item !== null && typeof item === 'object' && typeof (item as { image?: unknown }).image === 'string') {
        images.push({ url: (item as { image: string }).image, stitch: name });
      }
    }
  }
  return images;
}

/**
 * Why the stitch map cannot be converted, or null when it can. The converter diverts to `data.initial` by name, so a map
 * that is empty, or that does not hold that stitch, makes it write `-> undefined` — text the planner would then store as a
 * container. Refused here instead, where the writer is told what is wrong with the file.
 */
function stitchMapProblem(json: InklewriterJSON): { readonly code: string; readonly message: string } | null {
  const names = Object.keys(json.data.stitches);
  if (names.length === 0) {
    return { code: 'no-stitches', message: 'the story holds no stitches, so there is nothing to import' };
  }
  const first = json.data.stitches[json.data.initial];
  if (first === undefined || !Array.isArray(first.content)) {
    return {
      code: 'initial-missing',
      message: 'the stitch the story starts at is not in the file, so the import cannot tell where it begins',
    };
  }
  return null;
}

/**
 * The converter's own identifier rule (`createIdentifierFromString` in the vendored file): ASCII letters, digits and
 * underscores kept, a run of spaces or tabs folded to one underscore, everything else dropped, and a trailing underscore
 * removed. Written out here so a label can be tested against it before the converter runs.
 */
function inkIdentifier(label: string): string {
  let id = '';
  for (const c of label) {
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') id += c;
    else if ((c === ' ' || c === '\t') && id.length > 0 && id[id.length - 1] !== '_') id += '_';
  }
  return id.endsWith('_') ? id.slice(0, -1) : id;
}

/** Every string field of a content item that names a flag, whether it declares one or tests one. */
const FLAG_FIELDS = ['flagName', 'ifCondition', 'notIfCondition'] as const;

/** The two condition lists a choice carries, and the field each entry holds. */
const CONDITION_LISTS = [
  ['ifConditions', 'ifCondition'],
  ['notIfConditions', 'notIfCondition'],
] as const;

/**
 * The names in a flag expression or a condition. Inklewriter's flags are expressions (`myFlag = 9`, `myFlag + 1`), and a
 * condition can be one too (`count > 3`), so a name is a run between ink's operators and whitespace rather than the whole
 * string. A quoted literal is not a name: `name = "第一章"` compares text and must keep it.
 */
const NAME_RUN = /[^\s+\-*/=<>!&|(),]+/g;
const isLiteral = (token: string): boolean => token.startsWith('"') || token.startsWith("'");

/** Every flag expression of an item, including the two lists a choice carries. */
function flagExpressionsOf(item: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const field of FLAG_FIELDS) {
    const value = item[field];
    if (typeof value === 'string') values.push(value);
  }
  for (const [list, field] of CONDITION_LISTS) {
    const held = item[list];
    if (!Array.isArray(held)) continue;
    for (const entry of held) {
      if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>)[field] === 'string') {
        values.push((entry as Record<string, string>)[field] as string);
      }
    }
  }
  return values;
}

/**
 * Gives a usable name to every section label and flag name the converter would turn into the empty string, and returns the
 * renames. A label written only in characters the rule drops — `第一章`, `开关` — otherwise becomes a nameless knot
 * (`====  ====`), a nameless `VAR` and empty conditions: invalid Ink that the planner stores as one container. Naming them
 * here keeps the vendored converter untouched, and a flag is renamed everywhere it is declared **and** tested, since the
 * converter maps conditions by the original name. Two rules keep the new names honest: a generated name never collides with a
 * name the story already uses (two flags sharing one `VAR` would merge their logic), and a name inside an expression is
 * replaced as a whole token, so `计数 > 3` becomes `flag_1 > 3` while `name = "第一章"` keeps its quoted text.
 */
function nameUnusableLabels(json: InklewriterJSON): InklewriterRename[] {
  const items: Record<string, unknown>[] = [];
  for (const name of Object.keys(json.data.stitches)) {
    const stitch = json.data.stitches[name];
    if (stitch === undefined || !Array.isArray(stitch.content)) continue;
    for (const item of stitch.content) {
      if (item !== null && typeof item === 'object') items.push(item as unknown as Record<string, unknown>);
    }
  }

  // Every name the converter can already make, so a generated one never lands on it.
  const taken = new Set<string>();
  const unusableSections: string[] = [];
  const unusableFlags: string[] = [];
  for (const item of items) {
    const label = item['pageLabel'];
    if (typeof label === 'string' && label !== '') {
      const id = inkIdentifier(label);
      if (id === '') {
        if (!unusableSections.includes(label)) unusableSections.push(label);
      } else taken.add(id);
    }
    for (const expression of flagExpressionsOf(item)) {
      for (const token of expression.match(NAME_RUN) ?? []) {
        if (isLiteral(token)) continue;
        const id = inkIdentifier(token);
        if (id === '') {
          if (!unusableFlags.includes(token)) unusableFlags.push(token);
        } else taken.add(id);
      }
    }
  }

  // One new name per original, in story order, each free of every name already used or generated. A word used as both a
  // section label and a flag gets one of each, since a knot and a variable are different things.
  const flags = new Map<string, string>();
  const renames: InklewriterRename[] = [];
  let sections = 0;
  let flagCount = 0;
  const freeName = (prefix: string, next: () => number): string => {
    let candidate = `${prefix}_${next()}`;
    while (taken.has(candidate)) candidate = `${prefix}_${next()}`;
    taken.add(candidate);
    return candidate;
  };
  for (const name of unusableSections) {
    const to = freeName('section', () => (sections += 1));
    renames.push({ kind: 'section', from: name, to });
    for (const item of items) if (item['pageLabel'] === name) item['pageLabel'] = to;
  }
  for (const name of unusableFlags) {
    const to = freeName('flag', () => (flagCount += 1));
    flags.set(name, to);
    renames.push({ kind: 'flag', from: name, to });
  }

  const renameIn = (expression: string): string =>
    expression.replace(NAME_RUN, (token) => (isLiteral(token) ? token : (flags.get(token) ?? token)));

  for (const item of items) {
    for (const field of FLAG_FIELDS) {
      const value = item[field];
      if (typeof value === 'string') item[field] = renameIn(value);
    }
    for (const [list, field] of CONDITION_LISTS) {
      const held = item[list];
      if (!Array.isArray(held)) continue;
      for (const entry of held) {
        if (entry === null || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const value = record[field];
        if (typeof value === 'string') record[field] = renameIn(value);
      }
    }
  }
  return renames;
}

/** Reads an Inklewriter JSON export. Never throws for anything about the input: a refusal is `{ ok: false, error }`. */
export function readInklewriter(bytes: Uint8Array, fileName = ''): InklewriterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return refusal({ code: 'not-json', message: 'the file is not JSON; an Inklewriter export is a .json story' });
  }
  if (!isInklewriter(parsed)) {
    return refusal({ code: 'not-inklewriter', message: 'the JSON is not an Inklewriter story: it has no title, data.initial and stitches' });
  }
  const problem = stitchMapProblem(parsed);
  if (problem !== null) return refusal(problem);

  const renames = nameUnusableLabels(parsed);

  let ink: string;
  try {
    // terminateAllLooseEnds: a stitch that leads nowhere ends the story rather than falling off it.
    ink = convert(parsed, true);
  } catch (error) {
    return refusal({ code: 'convert-failed', message: error instanceof Error ? error.message : String(error) });
  }

  const plan = planInkImport(ink);
  const images = collectImages(parsed);
  const title = parsed.title !== '' ? parsed.title : fileName.replace(/\.json$/i, '') || 'Untitled';

  // Inklewriter keeps the editor's layout (where each stitch sat on the page); Caotang has no place for it.
  const losses = ['Inklewriter editor data (stitch positions) not imported'];
  const notices: string[] = [];

  return { ok: true, value: { plan, ink, title, images, losses, notices, renames } };
}
