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
 * The name a flag declaration names, parsed as the converter's own `Flag` class does: the text before an assignment, else
 * before a maths operator, else the whole text, trimmed. A flag name may contain spaces (`harbour master`), which the
 * converter folds to underscores, so it is not a whitespace-delimited token.
 */
function declaredFlagName(text: string): string {
  const assign = text.indexOf('=');
  if (assign !== -1) return text.slice(0, assign).trim();
  const math = text.search(/[+\-*/]/);
  if (math !== -1) return text.slice(0, math).trim();
  return text.trim();
}

/**
 * Runs `rename` over the parts of an expression that are not quoted literals, leaving every literal exactly as written. Ink
 * conditions compare text (`name = "the harbour master"`), and a literal may hold spaces and characters the name rule drops, so
 * it is opaque: never read for names, never rewritten. A scan rather than a regular expression, so the work is one pass over the
 * string whatever it holds — an escape skips two characters, and an unclosed quote runs to the end.
 */
function outsideLiterals(text: string, rename: (chunk: string) => string): string {
  let out = '';
  let plain = '';
  let at = 0;
  while (at < text.length) {
    const quote = text[at];
    if (quote !== '"' && quote !== "'") {
      plain += quote;
      at += 1;
      continue;
    }
    out += rename(plain);
    plain = '';
    let end = at + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
    const stop = Math.min(end + 1, text.length);
    out += text.slice(at, stop);
    at = stop;
  }
  return out + rename(plain);
}

/**
 * Gives a usable name to every section label and flag name the converter would turn into the empty string, and returns the
 * renames. A label written only in characters the rule drops — `第一章`, `开关` — otherwise becomes a nameless knot
 * (`====  ====`), a nameless `VAR` and empty conditions: invalid Ink that the planner stores as one container. Naming them
 * here keeps the vendored converter untouched, and a flag is renamed everywhere it is declared **and** tested, since the
 * converter maps conditions by the original name. Three rules keep the new names honest: a generated name never collides with a
 * name the story already uses (two flags sharing one `VAR` would merge their logic), names are the **declared** flag names — which
 * may contain spaces, as the converter's own parser reads them — replaced by substring exactly as the converter replaces them, so
 * `计数 > 3` becomes `flag_1 > 3`; and a quoted literal is opaque, so `name = "第一 章"` keeps every character it compares.
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

  // Every name the converter can already make, so a generated one never lands on it. A declared flag name is read whole
  // (`harbour master` is one name, not two), and a quoted literal names nothing.
  const taken = new Set<string>();
  const unusableSections: string[] = [];
  const unusableFlags: string[] = [];
  const note = (name: string, into: string[]): void => {
    if (name === '') return;
    const id = inkIdentifier(name);
    if (id === '') {
      if (!into.includes(name)) into.push(name);
    } else taken.add(id);
  };
  for (const item of items) {
    const label = item['pageLabel'];
    if (typeof label === 'string') note(label, unusableSections);
    const declared = item['flagName'];
    if (typeof declared === 'string') note(declaredFlagName(declared), unusableFlags);
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

  // Longest first, so a name that contains another (`开关门` over `开关`) is replaced whole.
  const ordered = [...flags.keys()].sort((a, b) => b.length - a.length);
  const renameChunk = (chunk: string): string => {
    let out = chunk;
    for (const from of ordered) out = out.split(from).join(flags.get(from) as string);
    return out;
  };
  const renameIn = (expression: string): string => (ordered.length === 0 ? expression : outsideLiterals(expression, renameChunk));

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
