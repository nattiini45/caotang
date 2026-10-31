/**
 * The parts of a Final Draft file around the script text (issue #265): the scene colour as a binder label, the
 * SmartType, cast and highlighting lists as codex seeds, and the production data Caotang has no home for, counted so
 * the import can say what it leaves behind, one notice per kind.
 *
 * Final Draft writes a colour as `#RRRRGGGGBBBB`, sixteen bits a channel; the binder keeps `#rrggbb`. A label is
 * matched to a scene colour by the nearest colour in the project's label vocabulary, within a small distance, and
 * otherwise named after the nearest colour of a short named palette, so the writer can rename it later.
 */

import { childElements, ownText, type XmlElement } from './fdx-xml.js';
import type { ImportedScene } from './import.js';

/** `#RRRRGGGGBBBB` (Final Draft), `#RRGGBB` or `#RGB` as `#rrggbb`; null for anything else, a blank value included. */
export function fdxColour(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  const hex = /^#?([0-9a-fA-F]+)$/.exec(text)?.[1];
  if (hex === undefined) return null;
  let rgb: string;
  if (hex.length === 12) rgb = `${hex.slice(0, 2)}${hex.slice(4, 6)}${hex.slice(8, 10)}`;
  else if (hex.length === 6) rgb = hex;
  else if (hex.length === 3) rgb = [...hex].map((c) => c + c).join('');
  else return null;
  return `#${rgb.toLowerCase()}`;
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The distance between two `#rrggbb` colours, in plain RGB: 0 is the same colour, about 441 black against white. */
export function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/** A scene colour that means "no colour": Final Draft's default card is white. */
export function isBlankSceneColour(hex: string): boolean {
  return hex === '#ffffff';
}

/** The named colours a new label takes its name from: Final Draft's scene colours and the usual binder ones. */
const PALETTE: readonly { readonly name: string; readonly hex: string }[] = [
  { name: 'Red', hex: '#e53935' },
  { name: 'Orange', hex: '#fb8c00' },
  { name: 'Yellow', hex: '#fdd835' },
  { name: 'Green', hex: '#43a047' },
  { name: 'Teal', hex: '#00897b' },
  { name: 'Cyan', hex: '#00bcd4' },
  { name: 'Blue', hex: '#1e88e5' },
  { name: 'Purple', hex: '#8e24aa' },
  { name: 'Pink', hex: '#ec407a' },
  { name: 'Brown', hex: '#795548' },
  { name: 'Grey', hex: '#9e9e9e' },
  { name: 'Black', hex: '#000000' },
];

/** The name of the nearest palette colour to `hex`, such as `Red`. */
export function colourName(hex: string): string {
  let best = PALETTE[0] as { readonly name: string; readonly hex: string };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of PALETTE) {
    const distance = colourDistance(hex, entry.hex);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.name;
}

/** How near a label's colour must be to a scene colour to stand for it. About a tenth of the black-to-white distance. */
export const LABEL_COLOUR_TOLERANCE = 48;

/** The label whose colour is nearest to `hex`, when one is within `LABEL_COLOUR_TOLERANCE`; otherwise undefined. */
export function nearestLabel<T extends { readonly color: string }>(hex: string, labels: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const label of labels) {
    const colour = fdxColour(label.color);
    if (colour === null) continue;
    const distance = colourDistance(hex, colour);
    if (distance < bestDistance) {
      best = label;
      bestDistance = distance;
    }
  }
  return bestDistance <= LABEL_COLOUR_TOLERANCE ? best : undefined;
}

/** Where a codex seed was read: a SmartType list, the cast, the character highlighting, or a Cast List paragraph. */
export type FdxSeedSource = 'smarttype' | 'cast' | 'highlighting' | 'cast-list';

/** A codex entry the import offers, unticked: a character or a place Final Draft already lists. */
export interface FdxCodexSeed {
  readonly name: string;
  readonly type: 'character' | 'location';
  /** From a Cast List line (`ANNA - a pilot`), or blank. */
  readonly description: string;
  readonly sources: readonly FdxSeedSource[];
}

/** The longest name a seed may have: the codex's own limit (`CODEX_NAME_MAX` in the bus). */
export const FDX_SEED_NAME_MAX = 120;

/** The most seeds one import offers. A cast past this is offered in part, with a notice. */
export const FDX_SEEDS_MAX = 500;

/** The elements directly under the document: the children of `<FinalDraft>`, or of the root of a fragment. */
export function topLevel(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of childElements(root)) {
    if (child.name === name) out.push(child);
    else if (child.name === 'FinalDraft') out.push(...childElements(child, name));
  }
  return out;
}

/** A Cast List line split into the name and what follows it: `ANNA - a pilot`, `ANNA, 30s`, `ANNA: a pilot`, `ANNA ..... a pilot`. */
export function castListLine(text: string): { readonly name: string; readonly description: string } {
  const line = text.replace(/\s+/g, ' ').trim();
  const split = /^(.*?)\s*(?:\s[-–—]\s|[,:]\s|\.{3,}|\t)\s*(.*)$/.exec(line);
  if (split === null) return { name: line, description: '' };
  return { name: (split[1] ?? '').trim(), description: (split[2] ?? '').trim() };
}

/**
 * The codex seeds of a document, in the order Final Draft lists them: SmartType characters, the cast, the character
 * highlighting, Cast List paragraphs, then SmartType locations. A name is offered once per type, whatever case it is
 * written in; the sources say where it was seen. `castList` is the text of the Cast List paragraphs, in order.
 */
export function collectSeeds(root: XmlElement, castList: readonly string[]): { seeds: FdxCodexSeed[]; skipped: number } {
  const byKey = new Map<string, { name: string; type: 'character' | 'location'; description: string; sources: FdxSeedSource[] }>();
  let skipped = 0;
  const add = (raw: string, type: 'character' | 'location', source: FdxSeedSource, description = ''): void => {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name === '') return;
    if ([...name].length > FDX_SEED_NAME_MAX) {
      skipped += 1;
      return;
    }
    const key = `${type}:${name.toLowerCase()}`;
    const seen = byKey.get(key);
    if (seen !== undefined) {
      if (!seen.sources.includes(source)) seen.sources.push(source);
      if (seen.description === '' && description !== '') seen.description = description;
      return;
    }
    byKey.set(key, { name, type, description, sources: [source] });
  };
  for (const smart of topLevel(root, 'SmartType')) {
    for (const list of childElements(smart, 'Characters')) for (const c of childElements(list, 'Character')) add(ownText(c), 'character', 'smarttype');
  }
  for (const cast of topLevel(root, 'Cast')) for (const member of childElements(cast, 'Member')) add(member.attrs.Character ?? '', 'character', 'cast');
  for (const highlighting of topLevel(root, 'CharacterHighlighting')) {
    for (const c of childElements(highlighting, 'Character')) add(c.attrs.Name ?? '', 'character', 'highlighting');
  }
  for (const line of castList) {
    const { name, description } = castListLine(line);
    add(name, 'character', 'cast-list', description);
  }
  for (const smart of topLevel(root, 'SmartType')) {
    for (const list of childElements(smart, 'Locations')) for (const l of childElements(list, 'Location')) add(ownText(l), 'location', 'smarttype');
  }
  const all = [...byKey.values()];
  const seeds = all.slice(0, FDX_SEEDS_MAX).map((s): FdxCodexSeed => ({ ...s, sources: [...s.sources] }));
  return { seeds, skipped: skipped + Math.max(0, all.length - FDX_SEEDS_MAX) };
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/** The longest passage a codex source quotes: the codex's own limit (`CODEX_SOURCE_QUOTE_MAX` in the bus). */
const QUOTE_MAX = 300;

/**
 * The first scene whose text names `name` as a whole word, ignoring case, and the line that names it (codex.import's
 * provenance rule: an entry attaches to a document whose text names it). Null when no scene does.
 */
export function namingScene(
  scenes: readonly Pick<ImportedScene, 'body'>[],
  name: string,
): { readonly index: number; readonly quote: string; readonly from: number; readonly to: number } | null {
  const wanted = name.toLowerCase();
  if (wanted === '') return null;
  for (let index = 0; index < scenes.length; index += 1) {
    const body = scenes[index]?.body ?? '';
    const lower = body.toLowerCase();
    // Lower-casing keeps the length for the scripts this reads; a body where it does not is matched on its own case.
    const haystack = lower.length === body.length ? lower : body;
    const needle = lower.length === body.length ? wanted : name;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[end])) {
        const lineStart = body.lastIndexOf('\n', at) + 1;
        const lineEndAt = body.indexOf('\n', end);
        const line = body.slice(lineStart, lineEndAt < 0 ? body.length : lineEndAt).trim();
        const quote = [...line].length <= QUOTE_MAX ? line : [...body.slice(at)].slice(0, QUOTE_MAX).join('').trim();
        return { index, quote, from: at, to: end };
      }
      at = haystack.indexOf(needle, at + 1);
    }
  }
  return null;
}

/** The production data a file holds that Caotang has no home for, counted per kind. Zero means none to lose. */
export interface FdxProductionData {
  /** Runs carrying a revision mark (`RevisionID` other than 0). */
  readonly revisedRuns: number;
  /** The names of the revision sets those runs belong to, in set order. */
  readonly revisionSets: readonly string[];
  /** Locked pages (`<LockedPages>` entries). */
  readonly lockedPages: number;
  /** Tagger breakdown tags (`<TagData>` definitions, or tagged runs when the file lists none). */
  readonly tags: number;
  /** Items on the Beat Board (`<DisplayBoard Type="Beat">` children). */
  readonly beats: number;
  /** Alternate dialogue sets (`<AltCollection>` children). */
  readonly altDialogue: number;
  /** Character arc beats with text, in scene properties. */
  readonly arcBeats: number;
}

function descendants(el: XmlElement, visit: (el: XmlElement) => void): void {
  const pending: XmlElement[] = [el];
  while (pending.length > 0) {
    const next = pending.pop() as XmlElement;
    visit(next);
    for (const child of next.children) if (typeof child !== 'string') pending.push(child);
  }
}

function hasText(el: XmlElement): boolean {
  let found = false;
  descendants(el, (d) => {
    if (!found && d.name === 'Text' && ownText(d).trim() !== '') found = true;
  });
  return found;
}

/**
 * Counts the production data of a document. `revisions` maps a revision id to the number of script runs marked with it;
 * `taggedRuns` counts runs that carry a tag number; `arcBeats` counts arc beats with text in the script's scene properties.
 */
export function productionData(
  root: XmlElement,
  revisions: ReadonlyMap<string, number>,
  taggedRuns: number,
  arcBeats: number,
): FdxProductionData {
  const names = new Map<string, string>();
  for (const set of topLevel(root, 'Revisions')) {
    for (const revision of childElements(set, 'Revision')) {
      const id = (revision.attrs.ID ?? '').trim();
      if (id !== '') names.set(id, (revision.attrs.Name ?? '').trim() || `set ${id}`);
    }
  }
  let revisedRuns = 0;
  const revisionSets: string[] = [];
  for (const [id, count] of [...revisions.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    revisedRuns += count;
    revisionSets.push(names.get(id) ?? `set ${id}`);
  }
  let lockedPages = 0;
  for (const locked of topLevel(root, 'LockedPages')) lockedPages += childElements(locked).length;
  let definitions = 0;
  for (const data of topLevel(root, 'TagData')) {
    descendants(data, (d) => {
      if (d.name === 'TagDefinition') definitions += 1;
    });
  }
  let beats = 0;
  for (const boards of topLevel(root, 'DisplayBoards')) {
    for (const board of childElements(boards, 'DisplayBoard')) if (board.attrs.Type === 'Beat') beats += childElements(board).length;
  }
  let altDialogue = 0;
  for (const alt of topLevel(root, 'AltCollection')) altDialogue += childElements(alt).length;
  return { revisedRuns, revisionSets, lockedPages, tags: definitions > 0 ? definitions : taggedRuns, beats, altDialogue, arcBeats };
}

/** The arc beats with text in a scene's properties (`SceneArcBeats/CharacterArcBeat`). Final Draft writes empty ones by default. */
export function arcBeatsWithText(sceneProperties: XmlElement): number {
  let count = 0;
  for (const beats of childElements(sceneProperties, 'SceneArcBeats')) {
    for (const beat of childElements(beats)) if (hasText(beat)) count += 1;
  }
  return count;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One notice per kind of production data present, each with its count, in a fixed order. */
export function productionNotices(data: FdxProductionData): string[] {
  const out: string[] = [];
  if (data.revisedRuns > 0) {
    const sets = data.revisionSets.length > 0 ? ` (${data.revisionSets.join(', ')})` : '';
    out.push(
      `Revision marks on ${plural(data.revisedRuns, 'run', 'runs')}${sets} were not kept, nor their colours and page colours: Caotang keeps no revision sets. The revised text was kept.`,
    );
  }
  if (data.lockedPages > 0) out.push(`${plural(data.lockedPages, 'locked page was', 'locked pages were')} not kept: Caotang does not lock pages.`);
  if (data.tags > 0) out.push(`${plural(data.tags, 'Tagger breakdown tag was', 'Tagger breakdown tags were')} not kept (props, wardrobe and other production categories).`);
  if (data.beats > 0) out.push(`${plural(data.beats, 'Beat Board item was', 'Beat Board items were')} not kept: only the script is imported.`);
  if (data.altDialogue > 0) out.push(`${plural(data.altDialogue, 'set of alternate dialogue was', 'sets of alternate dialogue were')} not kept: only the dialogue in the script is imported.`);
  if (data.arcBeats > 0) out.push(`${plural(data.arcBeats, 'character arc beat was', 'character arc beats were')} not kept (scene properties).`);
  return out;
}
