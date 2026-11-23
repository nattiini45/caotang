/**
 * The yWriter `.yw7` project reader (#291): one XML file, UTF-8 or UTF-16 (the mobile app writes UTF-16), read by the
 * shared namespace-aware reader. Written from the file format only — the upstream application is GPL, so nothing of
 * its code is consulted or copied.
 *
 * The tree: `YWRITER7 > CHAPTERS > CHAPTER` holds `Scenes > ScID` references into `SCENES > SCENE`; a `SectionStart`
 * chapter opens a part. `Type` non-zero (notes, to-do, unused) chapters and `PROJECTNOTES` become Research. A scene's
 * `Desc` is its synopsis, `SceneContent` its text with `[i]`/`[b]`/`[h1]`-`[h3]` markup, `Status` 1-5 a status word,
 * `Characters`/`Locations`/`Items` its declared cast (the first character is the point of view), `Goal`/`Conflict`/
 * `Outcome` and `Notes` its notes, `Tags` keywords, `Unused` an "unused" keyword, `Day` the day offset and
 * `LastsDays` the duration. `CHARACTERS`, `LOCATIONS` and `ITEMS` become codex rows with a details page.
 */

import { childElements, firstChild, readXml, textOf, type XmlElement } from '@caotang/import-read';

const BODY_CHARS = 1_000_000;
const NOTE_CHARS = 50_000;
const SYNOPSIS_CHARS = 2_000;

export interface Yw7Scene {
  readonly id: string;
  readonly title: string;
  readonly synopsis: string;
  readonly body: string;
  readonly keywords: readonly string[];
  readonly notes: readonly string[];
  readonly status?: string;
  readonly pov?: string;
  readonly dayOffset?: number;
  readonly durationDays?: number;
  readonly expectedPresent: readonly string[];
}

export interface Yw7Chapter {
  readonly id: string;
  readonly title: string;
  readonly synopsis: string;
  readonly scenes: readonly Yw7Scene[];
}

export interface Yw7Part {
  readonly title: string;
  readonly chapters: readonly Yw7Chapter[];
}

export interface Yw7CodexRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'character' | 'location' | 'item';
  readonly aliases: readonly string[];
  readonly page: { readonly title: string; readonly body: string };
}

export interface Yw7Loss {
  readonly code: 'clock-time' | 'calendar-date' | 'sub-day-duration' | 'markup-tag' | 'field';
  readonly message?: string;
  readonly count?: number;
}

export interface Yw7Research {
  readonly title: string;
  readonly body: string;
}

export interface Yw7Import {
  readonly parts: readonly Yw7Part[];
  readonly codex: readonly Yw7CodexRow[];
  readonly research: readonly Yw7Research[];
  readonly losses: readonly Yw7Loss[];
}

export type Yw7Error =
  | { readonly kind: 'not-yw7' }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'bad-xml'; readonly message: string }
  | { readonly kind: 'empty' };

export type Yw7Result = { readonly ok: true; readonly value: Yw7Import } | { readonly ok: false; readonly error: Yw7Error };

/** The status names 1-5 when the caller supplies none (the file's own STATUS list is honoured first). */
export interface Yw7Labels {
  readonly status1?: string;
  readonly status2?: string;
  readonly status3?: string;
  readonly status4?: string;
  readonly status5?: string;
}

export interface Yw7ReadOptions {
  readonly labels?: Yw7Labels;
}

export const DEFAULT_YW7_STATUS = ['Outline', 'Draft', 'First edit', 'Second edit', 'Done'] as const;

const stripControls = (text: string): string => [...text].map((char) => { const code = char.charCodeAt(0); return code < 32 && char !== '\n' && char !== '\t' ? ' ' : char === '\u007F' ? ' ' : char; }).join('');

const cut = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`);

/** The scene text's `[i]`/`[b]`/`[hN]` marks become Markdown; any other `[tag]` pair is dropped and counted. */
export function sceneMarkup(text: string): { body: string; dropped: number } {
  const raw = stripControls(text).replace(/\r\n?/g, '\n');
  let dropped = 0;
  const converted = raw
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '*$1*')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**')
    .replace(/\[h([1-3])\]([\s\S]*?)\[\/h\1\]/gi, (_match, level: string, inner: string) => `${'#'.repeat(Number(level))} ${inner.trim()}`)
    .replace(/\[\/?[a-zA-Z][a-zA-Z0-9]*\]/g, (tag) => {
      dropped += 1;
      return tag;
    });
  return { body: converted, dropped };
}

const int = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^-?\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : undefined;
};

const field = (element: XmlElement, name: string): string | undefined => {
  const child = firstChild(element, name);
  return child === undefined ? undefined : textOf(child).trim();
};

const flag = (text: string | undefined): boolean => text === '1' || text === '-1';

function codexRow(element: XmlElement, kind: Yw7CodexRow['kind'], losses: Yw7Loss[]): Yw7CodexRow | undefined {
  const id = field(element, 'ID') ?? '';
  const name = field(element, 'Title') ?? '';
  if (name === '') return undefined;
  const alias = field(element, 'AKA');
  const aliases = alias === undefined ? [] : alias.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const sections: string[] = [];
  const fullName = field(element, 'FullName');
  if (fullName !== undefined && fullName !== name) sections.push(`Name: ${fullName}`);
  for (const [key, heading] of [
    ['Desc', 'Description'],
    ['Bio', 'Biography'],
    ['Goals', 'Goals'],
    ['Notes', 'Notes'],
  ] as const) {
    const value = field(element, key);
    if (value !== undefined && value !== '') sections.push(`## ${heading}\n\n${cut(stripControls(value), NOTE_CHARS)}`);
  }
  const image = field(element, 'ImageFile');
  if (image !== undefined && image !== '') losses.push({ code: 'field', message: `The picture "${image}" of "${name}" is named but is not in the file.`, count: 1 });
  const body = sections.length === 0 ? `# ${name}` : `# ${name}\n\n${sections.join('\n\n')}`;
  return { id, name, kind, aliases, page: { title: name, body } };
}

export function readYw7(bytes: Uint8Array, options: Yw7ReadOptions = {}): Yw7Result {
  const parsed = readXml(bytes);
  if (!parsed.ok) {
    return parsed.error.code === 'too-large'
      ? { ok: false, error: { kind: 'too-large', bytes: bytes.length } }
      : { ok: false, error: { kind: 'bad-xml', message: parsed.error.message } };
  }
  const root = parsed.document.root;
  if (root.local !== 'YWRITER7' && root.local !== 'YW7') return { ok: false, error: { kind: 'not-yw7' } };

  const losses: Yw7Loss[] = [];

  // Codex first: a scene's declared cast resolves to entry names.
  const codex: Yw7CodexRow[] = [];
  // IDs restart per section, so each section keeps its own map.
  const namesBySection = { CHARACTERS: new Map<string, string>(), LOCATIONS: new Map<string, string>(), ITEMS: new Map<string, string>() };
  for (const [block, kind, tag] of [
    ['CHARACTERS', 'character', 'CHARACTER'],
    ['LOCATIONS', 'location', 'LOCATION'],
    ['ITEMS', 'item', 'ITEM'],
  ] as const) {
    const section = firstChild(root, block);
    if (section === undefined) continue;
    for (const element of childElements(section, tag)) {
      const row = codexRow(element, kind, losses);
      if (row === undefined) continue;
      codex.push(row);
      if (row.id !== '') namesBySection[block].set(row.id, row.name);
    }
  }

  const statusName = (raw: string | undefined): string | undefined => {
    const code = int(raw);
    if (code === undefined || code < 1 || code > 5) return undefined;
    const labels = options.labels;
    return [labels?.status1, labels?.status2, labels?.status3, labels?.status4, labels?.status5][code - 1] ?? DEFAULT_YW7_STATUS[code - 1];
  };

  const scenesById = new Map<string, Yw7Scene>();
  const scenesEl = firstChild(root, 'SCENES');
  if (scenesEl !== undefined) {
    for (const scene of childElements(scenesEl, 'SCENE')) {
      const id = field(scene, 'ID') ?? `scene-${scenesById.size + 1}`;
      const title = field(scene, 'Title') || `Scene ${id}`;
      const desc = field(scene, 'Desc');
      const content = sceneMarkup(field(scene, 'SceneContent') ?? '');
      if (content.dropped > 0) losses.push({ code: 'markup-tag', message: `Some [tag] marks in "${title}" were kept as text.`, count: content.dropped });
      const keywords: string[] = [];
      const notes: string[] = [];
      const tags = firstChild(scene, 'Tags');
      if (tags !== undefined) {
        for (const tag of childElements(tags, 'Tag').slice(0, 32)) {
          const name = textOf(tag).trim();
          if (name !== '') keywords.push(name.slice(0, 64));
        }
      }
      if (flag(field(scene, 'Unused'))) keywords.push('unused');
      for (const key of ['Goal', 'Conflict', 'Outcome', 'Notes'] as const) {
        const value = field(scene, key);
        if (value !== undefined && value !== '') notes.push(`${key === 'Notes' ? '' : `${key}: `}${cut(stripControls(value), NOTE_CHARS)}`);
      }
      const cast = new Set<string>();
      let pov: string | undefined;
      const characters = firstChild(scene, 'Characters');
      if (characters !== undefined) {
        for (const ref of childElements(characters, 'CharID')) {
          const name = namesBySection.CHARACTERS.get(textOf(ref).trim());
          if (name === undefined) continue;
          if (pov === undefined) pov = name;
          cast.add(name);
        }
      }
      for (const [wrap, tag, block] of [
        ['Locations', 'LocID', 'LOCATIONS'],
        ['Items', 'ItemID', 'ITEMS'],
      ] as const) {
        const section = firstChild(scene, wrap);
        if (section === undefined) continue;
        for (const ref of childElements(section, tag)) {
          const name = namesBySection[block].get(textOf(ref).trim());
          if (name !== undefined) cast.add(name);
        }
      }
      const day = int(field(scene, 'Day'));
      const hour = int(field(scene, 'Hour'));
      const minute = int(field(scene, 'Minute'));
      if (hour !== undefined || minute !== undefined) {
        losses.push({ code: 'clock-time', message: `The clock time of "${title}" sits in its notes: the timeline counts days.`, count: 1 });
        notes.push(`Time of day: ${hour ?? 0} h ${minute ?? 0} min`);
      }
      const when = field(scene, 'SpecificDateTime') ?? (field(scene, 'Date') !== undefined ? `${field(scene, 'Date')} ${field(scene, 'Time') ?? ''}`.trim() : undefined);
      if (when !== undefined && when !== '') {
        losses.push({ code: 'calendar-date', message: `The date "${when}" of "${title}" sits in its notes: the timeline counts days, not dates.`, count: 1 });
        notes.push(`When: ${when}`);
      }
      const lastsDays = int(field(scene, 'LastsDays'));
      const lastsHours = int(field(scene, 'LastsHours'));
      const lastsMinutes = int(field(scene, 'LastsMinutes'));
      if ((lastsHours !== undefined && lastsHours > 0) || (lastsMinutes !== undefined && lastsMinutes > 0)) {
        losses.push({ code: 'sub-day-duration', message: `The sub-day duration of "${title}" sits in its notes: durations are whole days.`, count: 1 });
        notes.push(`Lasts: ${[lastsHours !== undefined && lastsHours > 0 ? `${lastsHours} h` : '', lastsMinutes !== undefined && lastsMinutes > 0 ? `${lastsMinutes} min` : ''].filter((part) => part !== '').join(', ')}`);
      }
      const status = statusName(field(scene, 'Status'));
      scenesById.set(id, {
        id,
        title,
        synopsis: desc === undefined ? '' : cut(stripControls(desc), SYNOPSIS_CHARS),
        body: content.body.slice(0, BODY_CHARS),
        keywords,
        notes,
        ...(status === undefined ? {} : { status }),
        ...(pov === undefined ? {} : { pov }),
        expectedPresent: [...cast],
        ...(day === undefined ? {} : { dayOffset: day }),
        ...(lastsDays === undefined || lastsDays < 0 ? {} : { durationDays: lastsDays }),
      });
    }
  }

  // Chapters and parts in document order; a Type != 0 chapter (notes, to-do, unused) goes to Research.
  const parts: { title: string; chapters: Yw7Chapter[] }[] = [];
  const research: Yw7Research[] = [];
  const chaptersEl = firstChild(root, 'CHAPTERS');
  const ordered = new Set<string>();
  if (chaptersEl !== undefined) {
    for (const chapter of childElements(chaptersEl, 'CHAPTER')) {
      const title = field(chapter, 'Title') || 'Chapter';
      const desc = field(chapter, 'Desc');
      const scenes: Yw7Scene[] = [];
      const refs = firstChild(chapter, 'Scenes');
      if (refs !== undefined) {
        for (const ref of childElements(refs, 'ScID')) {
          const scene = scenesById.get(textOf(ref).trim());
          if (scene === undefined) continue;
          scenes.push(scene);
          ordered.add(scene.id);
        }
      }
      const type = int(field(chapter, 'Type')) ?? 0;
      const unused = flag(field(chapter, 'Unused'));
      if (type !== 0 || unused) {
        const kind = type === 1 ? 'notes' : type === 2 ? 'to-do' : type === 3 ? 'unused' : 'non-manuscript';
        const body = [`# ${title}`, ...(desc === undefined || desc === '' ? [] : [stripControls(desc)]), ...scenes.flatMap((scene) => [`## ${scene.title}`, ...(scene.synopsis === '' ? [] : [scene.synopsis]), ...(scene.body === '' ? [] : [scene.body])])].join('\n\n');
        research.push({ title, body });
        if (scenes.length > 0) losses.push({ code: 'field', message: `"${title}" is a ${kind} chapter; its scenes went to Research with it.`, count: 1 });
        continue;
      }
      const chapterRow: Yw7Chapter = {
        id: field(chapter, 'ID') ?? `chapter-${parts.reduce((sum, part) => sum + part.chapters.length, 0) + 1}`,
        title,
        synopsis: desc === undefined ? '' : cut(stripControls(desc), SYNOPSIS_CHARS),
        scenes,
      };
      const sectionStart = flag(field(chapter, 'SectionStart'));
      if (sectionStart || parts.length === 0) {
        // A part-start chapter opens the part; the scenes it lists stay under its own title as the part's first chapter.
        parts.push({ title: sectionStart ? title : 'Manuscript', chapters: sectionStart && scenes.length === 0 ? [] : [chapterRow] });
        continue;
      }
      parts[parts.length - 1]?.chapters.push(chapterRow);
    }
  }
  const orphans = [...scenesById.values()].filter((scene) => !ordered.has(scene.id));
  if (orphans.length > 0) parts.push({ title: 'Unsorted', chapters: [{ id: 'unsorted', title: 'Unsorted', synopsis: '', scenes: orphans }] });

  const projectNotes = firstChild(root, 'PROJECTNOTES');
  if (projectNotes !== undefined) {
    for (const note of childElements(projectNotes, 'PROJECTNOTE')) {
      const title = field(note, 'Title') || 'Project note';
      const desc = field(note, 'Desc') ?? '';
      research.push({ title, body: `# ${title}\n\n${stripControls(desc)}` });
    }
  }

  if (parts.length === 0 && codex.length === 0 && research.length === 0) return { ok: false, error: { kind: 'empty' } };
  return { ok: true, value: { parts, codex, research, losses } };
}
