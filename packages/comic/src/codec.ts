/**
 * Reading and writing the stored comic values — comics.md §2, project-format.md §6.
 *
 * Two different contracts live here on purpose:
 *
 * - **`load*` is tolerant.** It never throws and never drops a key it does not know: unknown book keys, unknown
 *   balloon keys, unknown enum values and a `scriptDocId` that resolves to nothing all survive. What it cannot
 *   render (a rect that is not four numbers) is replaced by a safe default and reported in `issues`, so the page
 *   still draws; the stored file is not touched until a command writes a whole value back.
 * - **`validate*` is strict.** It is the write boundary: finite normalized rectangles, well-formed unique ids and
 *   closed enum values. An enum value the loader kept may be written back only when it is the value already stored
 *   (`previous`), so an unknown value survives a round trip but cannot be written anew.
 */

import { ID_BODY_PATTERN, newId, type RandomBytes } from '@caotang/ids';
import {
  BALLOON_KINDS,
  BALLOON_STYLES,
  DEFAULT_LETTERING_FACE,
  PAGE_SIZES,
  PANEL_BORDERS,
  READING_DIRECTIONS,
  isRecord,
  type Balloon,
  type ComicBookSettings,
  type ComicPage,
  type DialogueCoverage,
  type Panel,
  type Point,
  type Rect,
  type TextAnchor,
} from './model.js';
import { msg, type MessageRef } from './message.js';

const EPSILON = 1e-9;

export const MAX_PANELS_PER_PAGE = 64;
export const MAX_BALLOONS_PER_PANEL = 64;
export const MAX_BALLOON_TEXT_LENGTH = 10_000;

/** What a balloon ends up as when its stored rect cannot be read. */
export const FALLBACK_BALLOON_RECT: Rect = [0.1, 0.1, 0.3, 0.15];
export const FULL_RECT: Rect = [0, 0, 1, 1];

export const DEFAULT_BOOK_SETTINGS: Readonly<Required<Omit<ComicBookSettings, 'scriptDocId'>>> = {
  readingDirection: 'ltr',
  letteringFace: DEFAULT_LETTERING_FACE,
  capsTransform: true,
  esszett: false,
  pageSize: 'us-comic',
};

export const PANEL_ID_PATTERN = new RegExp(`^pn_${ID_BODY_PATTERN}$`);
export const BALLOON_ID_PATTERN = new RegExp(`^bl_${ID_BODY_PATTERN}$`);

/** What a stored id may look like. Minted ids are `pn_`/`bl_` plus ten characters; a hand-written id still loads. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function mint(prefix: 'pn' | 'bl', taken: ReadonlySet<string>, randomBytes?: RandomBytes): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const body = newId('c', randomBytes ? { randomBytes } : {}).slice(2);
    const candidate = `${prefix}_${body}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not mint a unique ${prefix}_ id after 8 attempts`);
}

export const mintPanelId = (taken: ReadonlySet<string>, randomBytes?: RandomBytes): string =>
  mint('pn', taken, randomBytes);
export const mintBalloonId = (taken: ReadonlySet<string>, randomBytes?: RandomBytes): string =>
  mint('bl', taken, randomBytes);

export interface LoadIssue {
  /** e.g. `panels[2].balloons[0].rect` */
  path: string;
  code: 'wrongType' | 'missing' | 'badRect' | 'badPoint' | 'duplicateId' | 'dropped';
}

export interface ValidationError {
  path: string;
  code: string;
  message: MessageRef;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

export function isFiniteRect(value: unknown): value is Rect {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Four finite numbers, a start inside 0..1, a positive size, and the far edge not past 1. */
export function isNormalizedRect(value: unknown): value is Rect {
  if (!isFiniteRect(value)) return false;
  const [x, y, w, h] = value;
  return x >= 0 && y >= 0 && x <= 1 && y <= 1 && w > 0 && h > 0 && x + w <= 1 + EPSILON && y + h <= 1 + EPSILON;
}

export function isNormalizedPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  );
}

export const isComicId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);

// ---------------------------------------------------------------- tolerant load

export interface Loaded<T> {
  value: T;
  issues: LoadIssue[];
}

export function loadComicBook(raw: unknown): Loaded<ComicBookSettings> {
  const issues: LoadIssue[] = [];
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.push({ path: '', code: 'wrongType' });
  const value = { ...DEFAULT_BOOK_SETTINGS, ...source } as ComicBookSettings;

  const stringField = (key: 'readingDirection' | 'letteringFace' | 'pageSize'): void => {
    const v = source[key];
    if (v === undefined) return;
    if (typeof v === 'string' && v.length > 0) return;
    issues.push({ path: key, code: 'wrongType' });
    (value as Record<string, unknown>)[key] = DEFAULT_BOOK_SETTINGS[key];
  };
  stringField('readingDirection');
  stringField('letteringFace');
  stringField('pageSize');
  for (const key of ['capsTransform', 'esszett'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') {
      issues.push({ path: key, code: 'wrongType' });
      (value as Record<string, unknown>)[key] = DEFAULT_BOOK_SETTINGS[key];
    }
  }
  if ('scriptDocId' in source) {
    const id = source['scriptDocId'];
    if (typeof id === 'string' && id.length > 0) value.scriptDocId = id;
    else {
      issues.push({ path: 'scriptDocId', code: 'wrongType' });
      delete value.scriptDocId;
    }
  }
  return { value, issues };
}

function loadRect(raw: unknown, fallback: Rect, path: string, issues: LoadIssue[]): Rect {
  if (isNormalizedRect(raw)) return [raw[0], raw[1], raw[2], raw[3]];
  issues.push({ path, code: 'badRect' });
  return fallback;
}

function loadAnchor(raw: unknown): TextAnchor | undefined {
  if (!isRecord(raw)) return undefined;
  const { from, to, exact, prefix, suffix, capturedRevision } = raw;
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    typeof exact !== 'string' ||
    typeof prefix !== 'string' ||
    typeof suffix !== 'string' ||
    typeof capturedRevision !== 'number'
  )
    return undefined;
  return { ...raw, from, to, exact, prefix, suffix, capturedRevision };
}

function loadBalloon(raw: unknown, index: number, path: string, issues: LoadIssue[]): Balloon | undefined {
  if (!isRecord(raw)) {
    issues.push({ path, code: 'dropped' });
    return undefined;
  }
  const balloon: Balloon = {
    ...raw,
    id: typeof raw['id'] === 'string' && raw['id'].length > 0 ? raw['id'] : `balloon-${index + 1}`,
    kind: typeof raw['kind'] === 'string' ? raw['kind'] : 'speech',
    text: typeof raw['text'] === 'string' ? raw['text'] : '',
    rect: loadRect(raw['rect'], FALLBACK_BALLOON_RECT, `${path}.rect`, issues),
  };
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) issues.push({ path: `${path}.id`, code: 'missing' });
  if (typeof raw['kind'] !== 'string') issues.push({ path: `${path}.kind`, code: 'missing' });
  if (typeof raw['text'] !== 'string') issues.push({ path: `${path}.text`, code: 'wrongType' });
  if (raw['tail'] !== undefined) {
    if (isNormalizedPoint(raw['tail'])) balloon.tail = [raw['tail'][0], raw['tail'][1]];
    else {
      issues.push({ path: `${path}.tail`, code: 'badPoint' });
      delete balloon.tail;
    }
  }
  if (raw['offPanel'] !== undefined && raw['offPanel'] !== true) {
    issues.push({ path: `${path}.offPanel`, code: 'wrongType' });
    delete balloon.offPanel;
  }
  return balloon;
}

function loadPanel(raw: unknown, index: number, path: string, issues: LoadIssue[]): Panel | undefined {
  if (!isRecord(raw)) {
    issues.push({ path, code: 'dropped' });
    return undefined;
  }
  const balloons: Balloon[] = [];
  if (raw['balloons'] !== undefined && !Array.isArray(raw['balloons'])) {
    issues.push({ path: `${path}.balloons`, code: 'wrongType' });
  } else if (Array.isArray(raw['balloons'])) {
    raw['balloons'].forEach((entry: unknown, i) => {
      const loaded = loadBalloon(entry, i, `${path}.balloons[${i}]`, issues);
      if (loaded !== undefined) balloons.push(loaded);
    });
  }
  const panel: Panel = {
    ...raw,
    id: typeof raw['id'] === 'string' && raw['id'].length > 0 ? raw['id'] : `panel-${index + 1}`,
    rect: loadRect(raw['rect'], FULL_RECT, `${path}.rect`, issues),
    balloons,
  };
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) issues.push({ path: `${path}.id`, code: 'missing' });
  if (raw['crop'] !== undefined) {
    if (isNormalizedRect(raw['crop'])) panel.crop = [raw['crop'][0], raw['crop'][1], raw['crop'][2], raw['crop'][3]];
    else {
      issues.push({ path: `${path}.crop`, code: 'badRect' });
      delete panel.crop;
    }
  }
  if (raw['assetId'] !== undefined && typeof raw['assetId'] !== 'string') {
    issues.push({ path: `${path}.assetId`, code: 'wrongType' });
    delete panel.assetId;
  }
  if (raw['script'] !== undefined) {
    if (!Array.isArray(raw['script'])) {
      issues.push({ path: `${path}.script`, code: 'wrongType' });
      delete panel.script;
    } else {
      const script: DialogueCoverage[] = [];
      raw['script'].forEach((entry: unknown, i) => {
        const anchor = isRecord(entry) ? loadAnchor(entry['anchor']) : undefined;
        if (!isRecord(entry) || anchor === undefined || typeof entry['docId'] !== 'string') {
          issues.push({ path: `${path}.script[${i}]`, code: 'dropped' });
          return;
        }
        script.push({ ...entry, kind: 'comic-script-line', docId: entry['docId'], anchor });
      });
      panel.script = script;
    }
  }
  return panel;
}

export function loadComicPage(raw: unknown): Loaded<ComicPage> {
  const issues: LoadIssue[] = [];
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.push({ path: '', code: 'wrongType' });
  const panels: Panel[] = [];
  if (source['panels'] !== undefined && !Array.isArray(source['panels'])) {
    issues.push({ path: 'panels', code: 'wrongType' });
  } else if (Array.isArray(source['panels'])) {
    source['panels'].forEach((entry: unknown, i) => {
      const loaded = loadPanel(entry, i, `panels[${i}]`, issues);
      if (loaded !== undefined) panels.push(loaded);
    });
  }
  const seen = new Set<string>();
  for (const [pi, panel] of panels.entries()) {
    if (seen.has(panel.id)) issues.push({ path: `panels[${pi}].id`, code: 'duplicateId' });
    seen.add(panel.id);
    for (const [bi, balloon] of panel.balloons.entries()) {
      if (seen.has(balloon.id)) issues.push({ path: `panels[${pi}].balloons[${bi}].id`, code: 'duplicateId' });
      seen.add(balloon.id);
    }
  }
  const page: ComicPage = {
    ...source,
    size: typeof source['size'] === 'string' && source['size'].length > 0 ? source['size'] : 'us-comic',
    panels,
  };
  if (typeof source['size'] !== 'string' || source['size'].length === 0) {
    issues.push({ path: 'size', code: source['size'] === undefined ? 'missing' : 'wrongType' });
  }
  if (source['layout'] !== undefined && typeof source['layout'] !== 'string') {
    issues.push({ path: 'layout', code: 'wrongType' });
    delete page.layout;
  }
  return { value: page, issues };
}

// ---------------------------------------------------------------- strict validation

class Errors {
  readonly list: ValidationError[] = [];
  add(path: string, code: string, message: string, values?: Record<string, string | number>): void {
    this.list.push({ path, code, message: msg(`comic.invalid.${code}`, `{path}: ${message}`, { path, ...values }) });
  }
}

function checkEnum(
  errors: Errors,
  path: string,
  value: unknown,
  list: readonly string[],
  previous: unknown,
): boolean {
  if (typeof value === 'string' && (list.includes(value) || value === previous)) return true;
  errors.add(path, 'enum', 'must be one of {allowed}.', { allowed: list.join(', ') });
  return false;
}

const RECT_RULE = 'must be four finite numbers: a start from 0 to 1, a size above 0, and no edge past 1.';

function copyKnownOptional<T extends Record<string, unknown>>(target: T, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

export function validateComicBook(raw: unknown, previous?: ComicBookSettings): Validation<ComicBookSettings> {
  const errors = new Errors();
  if (!isRecord(raw)) {
    errors.add('', 'type', 'the book settings must be an object.');
    return { ok: false, errors: errors.list };
  }
  const value = { ...DEFAULT_BOOK_SETTINGS, ...raw } as ComicBookSettings;
  checkEnum(errors, 'readingDirection', value.readingDirection, READING_DIRECTIONS, previous?.readingDirection);
  checkEnum(errors, 'pageSize', value.pageSize, PAGE_SIZES, previous?.pageSize);
  if (typeof value.letteringFace !== 'string' || value.letteringFace.length === 0 || value.letteringFace.length > 64) {
    errors.add('letteringFace', 'string', 'must be a face name of 1 to 64 characters.');
  }
  for (const key of ['capsTransform', 'esszett'] as const) {
    if (typeof value[key] !== 'boolean') errors.add(key, 'boolean', 'must be true or false.');
  }
  if ('scriptDocId' in raw) {
    if (typeof raw['scriptDocId'] !== 'string' || raw['scriptDocId'].length === 0) {
      errors.add('scriptDocId', 'scriptDocId', 'must be a document id, or left out when the book has no script.');
    }
  }
  return errors.list.length > 0 ? { ok: false, errors: errors.list } : { ok: true, value };
}

function validateAnchor(errors: Errors, path: string, raw: unknown): TextAnchor | undefined {
  if (!isRecord(raw)) {
    errors.add(path, 'anchor', 'must be a text anchor.');
    return undefined;
  }
  const { from, to, exact, prefix, suffix, capturedRevision } = raw;
  const ok =
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    (from as number) >= 0 &&
    (to as number) > (from as number) &&
    typeof exact === 'string' &&
    exact.length > 0 &&
    typeof prefix === 'string' &&
    typeof suffix === 'string' &&
    Number.isInteger(capturedRevision) &&
    (capturedRevision as number) >= 0;
  if (!ok) {
    errors.add(path, 'anchor', 'must be a text anchor with a from, a to after it, the exact text and a revision.');
    return undefined;
  }
  return { ...raw, from, to, exact, prefix, suffix, capturedRevision } as TextAnchor;
}

function validateBalloon(
  errors: Errors,
  path: string,
  raw: unknown,
  ids: Set<string>,
  previous: Balloon | undefined,
): Balloon | undefined {
  if (!isRecord(raw)) {
    errors.add(path, 'type', 'a balloon must be an object.');
    return undefined;
  }
  const before = errors.list.length;
  const { id, kind, text, speaker, rect, tail, offPanel, fontSize, style } = raw;
  if (!isComicId(id)) errors.add(`${path}.id`, 'id', 'must be an id of letters, digits, hyphens and underscores.');
  else if (ids.has(id)) errors.add(`${path}.id`, 'duplicateId', 'is already used on this page.');
  else ids.add(id);
  checkEnum(errors, `${path}.kind`, kind, BALLOON_KINDS, previous?.kind);
  if (typeof text !== 'string' || text.length > MAX_BALLOON_TEXT_LENGTH) {
    errors.add(`${path}.text`, 'text', 'must be text of at most {max} characters.', { max: MAX_BALLOON_TEXT_LENGTH });
  }
  if (speaker !== undefined && (typeof speaker !== 'string' || speaker.length === 0)) {
    errors.add(`${path}.speaker`, 'speaker', 'must be a codex id, or left out.');
  }
  if (!isNormalizedRect(rect)) errors.add(`${path}.rect`, 'rect', RECT_RULE);
  if (tail !== undefined && !isNormalizedPoint(tail)) {
    errors.add(`${path}.tail`, 'point', 'must be two finite numbers from 0 to 1.');
  }
  if (offPanel !== undefined && offPanel !== true) errors.add(`${path}.offPanel`, 'offPanel', 'must be true, or left out.');
  if (fontSize !== undefined && !(typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize > 0)) {
    errors.add(`${path}.fontSize`, 'fontSize', 'must be a number above 0, or left out.');
  }
  if (style !== undefined) checkEnum(errors, `${path}.style`, style, BALLOON_STYLES, previous?.style);
  if (errors.list.length > before) return undefined;
  const balloon: Balloon = { ...raw, id: id as string, kind: kind as string, text: text as string, rect: rect as Rect };
  copyKnownOptional(balloon, 'speaker', speaker);
  copyKnownOptional(balloon, 'tail', tail);
  copyKnownOptional(balloon, 'offPanel', offPanel);
  copyKnownOptional(balloon, 'fontSize', fontSize);
  copyKnownOptional(balloon, 'style', style);
  return balloon;
}

function validatePanel(
  errors: Errors,
  path: string,
  raw: unknown,
  ids: Set<string>,
  previous: Panel | undefined,
): Panel | undefined {
  if (!isRecord(raw)) {
    errors.add(path, 'type', 'a panel must be an object.');
    return undefined;
  }
  const before = errors.list.length;
  const { id, rect, assetId, crop, border, balloons, script } = raw;
  if (!isComicId(id)) errors.add(`${path}.id`, 'id', 'must be an id of letters, digits, hyphens and underscores.');
  else if (ids.has(id)) errors.add(`${path}.id`, 'duplicateId', 'is already used on this page.');
  else ids.add(id);
  if (!isNormalizedRect(rect)) errors.add(`${path}.rect`, 'rect', RECT_RULE);
  if (assetId !== undefined && (typeof assetId !== 'string' || assetId.length === 0)) {
    errors.add(`${path}.assetId`, 'assetId', 'must be a picture id, or left out.');
  }
  if (crop !== undefined && !isNormalizedRect(crop)) errors.add(`${path}.crop`, 'rect', RECT_RULE);
  if (border !== undefined) checkEnum(errors, `${path}.border`, border, PANEL_BORDERS, previous?.border);

  const outBalloons: Balloon[] = [];
  if (!Array.isArray(balloons)) errors.add(`${path}.balloons`, 'array', 'must be a list of balloons.');
  else if (balloons.length > MAX_BALLOONS_PER_PANEL) {
    errors.add(`${path}.balloons`, 'tooMany', 'may hold at most {max} balloons.', { max: MAX_BALLOONS_PER_PANEL });
  } else {
    const previousById = new Map((previous?.balloons ?? []).map((b) => [b.id, b]));
    balloons.forEach((entry: unknown, i) => {
      const entryId = isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined;
      const balloon = validateBalloon(
        errors,
        `${path}.balloons[${i}]`,
        entry,
        ids,
        entryId === undefined ? undefined : previousById.get(entryId),
      );
      if (balloon !== undefined) outBalloons.push(balloon);
    });
  }

  let outScript: DialogueCoverage[] | undefined;
  if (script !== undefined) {
    if (!Array.isArray(script)) errors.add(`${path}.script`, 'array', 'must be a list of covered script lines.');
    else {
      outScript = [];
      script.forEach((entry: unknown, i) => {
        const at = `${path}.script[${i}]`;
        if (!isRecord(entry) || entry['kind'] !== 'comic-script-line' || typeof entry['docId'] !== 'string') {
          errors.add(at, 'coverage', 'must name a comic-script-line and its document.');
          return;
        }
        if (entry['balloonId'] !== undefined && typeof entry['balloonId'] !== 'string') {
          errors.add(`${at}.balloonId`, 'coverage', 'must be a balloon id, or left out.');
          return;
        }
        const anchor = validateAnchor(errors, `${at}.anchor`, entry['anchor']);
        if (anchor !== undefined) outScript?.push({ ...entry, kind: 'comic-script-line', docId: entry['docId'], anchor });
      });
    }
  }
  if (errors.list.length > before) return undefined;
  const panel: Panel = { ...raw, id: id as string, rect: rect as Rect, balloons: outBalloons };
  copyKnownOptional(panel, 'assetId', assetId);
  copyKnownOptional(panel, 'crop', crop);
  copyKnownOptional(panel, 'border', border);
  copyKnownOptional(panel, 'script', outScript);
  return panel;
}

/**
 * The write boundary of `comic.setPage`. `previous` is the page being replaced: an enum value it already holds
 * may be written back unchanged.
 */
export function validateComicPage(raw: unknown, previous?: ComicPage): Validation<ComicPage> {
  const errors = new Errors();
  if (!isRecord(raw)) {
    errors.add('', 'type', 'a comic page must be an object.');
    return { ok: false, errors: errors.list };
  }
  const { size, layout, panels } = raw;
  checkEnum(errors, 'size', size, PAGE_SIZES, previous?.size);
  if (layout !== undefined && (typeof layout !== 'string' || layout.length === 0 || layout.length > 64)) {
    errors.add('layout', 'layout', 'must be a template id of 1 to 64 characters, or left out.');
  }
  const out: Panel[] = [];
  if (!Array.isArray(panels)) errors.add('panels', 'array', 'must be a list of panels.');
  else if (panels.length > MAX_PANELS_PER_PAGE) {
    errors.add('panels', 'tooMany', 'may hold at most {max} panels.', { max: MAX_PANELS_PER_PAGE });
  } else {
    const ids = new Set<string>();
    const previousById = new Map((previous?.panels ?? []).map((p) => [p.id, p]));
    panels.forEach((entry: unknown, i) => {
      const entryId = isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined;
      const panel = validatePanel(
        errors,
        `panels[${i}]`,
        entry,
        ids,
        entryId === undefined ? undefined : previousById.get(entryId),
      );
      if (panel !== undefined) out.push(panel);
    });
  }
  if (errors.list.length > 0) return { ok: false, errors: errors.list };
  const page: ComicPage = { ...raw, size: size as string, panels: out };
  copyKnownOptional(page, 'layout', layout);
  return { ok: true, value: page };
}

/** A plain JSON copy with the spec's own keys first, so a saved page diffs the same way every time. */
export function serializeComicPage(page: ComicPage): Record<string, unknown> {
  const { size, layout, panels, ...rest } = page;
  const out: Record<string, unknown> = { size };
  if (layout !== undefined) out['layout'] = layout;
  out['panels'] = panels.map((panel) => {
    const { id, rect, assetId, crop, border, balloons, script, ...panelRest } = panel;
    const p: Record<string, unknown> = { id, rect: [...rect] };
    if (assetId !== undefined) p['assetId'] = assetId;
    if (crop !== undefined) p['crop'] = [...crop];
    if (border !== undefined) p['border'] = border;
    p['balloons'] = balloons.map((balloon) => {
      const { id: bid, kind, text, speaker, rect: brect, tail, offPanel, fontSize, style, ...balloonRest } = balloon;
      const b: Record<string, unknown> = { id: bid, kind, text };
      if (speaker !== undefined) b['speaker'] = speaker;
      b['rect'] = [...brect];
      if (tail !== undefined) b['tail'] = [...tail];
      if (offPanel !== undefined) b['offPanel'] = offPanel;
      if (fontSize !== undefined) b['fontSize'] = fontSize;
      if (style !== undefined) b['style'] = style;
      return Object.assign(b, balloonRest);
    });
    if (script !== undefined) p['script'] = script.map((entry) => ({ ...entry, anchor: { ...entry.anchor } }));
    return Object.assign(p, panelRest);
  });
  return Object.assign(out, rest);
}

export function serializeComicBook(settings: ComicBookSettings): Record<string, unknown> {
  const { readingDirection, letteringFace, capsTransform, esszett, pageSize, scriptDocId, ...rest } = settings;
  const out: Record<string, unknown> = { readingDirection, letteringFace, capsTransform, esszett, pageSize };
  if (scriptDocId !== undefined) out['scriptDocId'] = scriptDocId;
  return Object.assign(out, rest);
}
