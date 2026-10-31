/**
 * `comic.derive` and `comic.letter` as pure functions — comics.md §3.2. Derive turns a comic script into pages, panels and
 * balloon text; letter places or updates the balloons of one page from the script lines. Neither writes a picture: a panel's
 * `assetId` and `crop` are only ever carried over from the page that was there, and a derivation that would have to move a
 * panel that holds a picture is refused instead.
 *
 * The rules a reader would otherwise have to guess:
 * - A script page maps to the book's page at the same position (`PAGE 3` is the third page in binder order), and the script's
 *   pages must run 1 to N in order. A page the book does not have yet is created; a book's later pages are left alone.
 * - A balloon is *this script's* when a panel's `script` entry for this document names it. Derive pairs those balloons with the
 *   panel's script lines in order, updates the pair in place (the id, the geometry and the size stay the writer's) and makes a new
 *   balloon for a line with no pair. A balloon with no such entry is hand-lettered and is never touched.
 * - Derive removes a script balloon whose line is gone from the script; letter never removes anything.
 * - Every placed or updated line gets a fresh anchor over the script body the plan read, so the coverage check can follow it.
 */

import type { RandomBytes } from '@caotang/ids';

import { MAX_BALLOONS_PER_PANEL, MAX_PANELS_PER_PAGE, mintBalloonId, mintPanelId } from './codec.js';
import { panelRectsFor, templateForPanelCount } from './layout.js';
import { msg, type MessageRef } from './message.js';
import type { Balloon, ComicPage, ComicBookSettings, DialogueCoverage, Panel, Rect, TextAnchor } from './model.js';
import { parseComicScript, type ScriptLine, type ScriptPage } from './script.js';

/** edit-anchors.md §2: a prefix and suffix of up to 32 characters, and an exact of 1 to 2000. */
const ANCHOR_CONTEXT_CHARS = 32;
const ANCHOR_MAX_EXACT_CHARS = 2000;

/** A fresh anchor over `body[from, to)`; `undefined` for a range the anchor's bounds cannot hold. */
export function captureAnchor(body: string, from: number, to: number, revision: number): TextAnchor | undefined {
  if (from < 0 || to <= from || to > body.length || to - from > ANCHOR_MAX_EXACT_CHARS) return undefined;
  return {
    from,
    to,
    exact: body.slice(from, to),
    prefix: body.slice(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    suffix: body.slice(to, to + ANCHOR_CONTEXT_CHARS),
    capturedRevision: revision,
  };
}

export interface CodexNameEntry {
  id: string;
  name: string;
  aliases?: readonly string[];
}

const nameKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLocaleUpperCase();

/**
 * Script speaker name to codex id: the one entry whose name or alias is that name, ignoring case and spacing. Two entries with the
 * same name resolve to neither, because a balloon's speaker is an id and a guess between two would be a wrong one.
 */
export function speakerResolver(entries: readonly CodexNameEntry[]): (speakerName: string) => string | undefined {
  const byName = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const term of [entry.name, ...(entry.aliases ?? [])]) {
      const key = nameKey(term);
      if (key === '') continue;
      const ids = byName.get(key) ?? new Set<string>();
      ids.add(entry.id);
      byName.set(key, ids);
    }
  }
  return (speakerName) => {
    const ids = byName.get(nameKey(speakerName));
    return ids !== undefined && ids.size === 1 ? [...ids][0] : undefined;
  };
}

export interface DeriveProblem {
  code:
    | 'noPages'
    | 'pageNumbers'
    | 'tooManyPanels'
    | 'tooManyBalloons'
    | 'picturesInTheWay'
    | 'dropsLettering'
    | 'noScriptPage'
    | 'panelsMissing'
    | 'noScriptPanel'
    | 'noScriptLine';
  message: MessageRef;
}

const problem = (code: DeriveProblem['code'], id: string, message: string, values?: Record<string, string | number>): DeriveProblem => ({
  code,
  message: msg(`comic.derive.${id}`, message, values),
});

export interface ScriptSource {
  /** The book's linked script document. */
  docId: string;
  body: string;
  /** The revision `body` is at, recorded in each anchor. */
  revision: number;
}

interface LetterContext extends ScriptSource {
  readingDirection: string;
  speakerId: (speakerName: string) => string | undefined;
  randomBytes?: RandomBytes;
}

const isMine = (entry: DialogueCoverage, docId: string): boolean => entry.kind === 'comic-script-line' && entry.docId === docId;

/** Where the `k`th of `n` balloons of a panel goes: stacked down the panel, alternating sides in the book's reading direction. */
export function defaultBalloonRect(panel: Rect, k: number, n: number, readingDirection: string): Rect {
  const [px, py, pw, ph] = panel;
  const height = Math.min(0.22, 0.8 / Math.max(1, n)) * ph;
  const width = 0.6 * pw;
  const startsRight = readingDirection === 'rtl';
  const rightSide = (k % 2 === 0) === startsRight;
  const x = px + (rightSide ? pw - width - 0.05 * pw : 0.05 * pw);
  const y = Math.min(py + 0.04 * ph + k * (height + 0.02 * ph), py + ph - height);
  // Rounded down, so the rectangle can only end up inside the panel's own edges.
  const down = (v: number): number => Math.floor(v * 1e4) / 1e4;
  return [down(x), down(y), down(width), down(height)];
}

interface PanelLettering {
  panel: Panel;
  placed: number;
  updated: number;
  removed: number;
}

interface LetterPanelOptions {
  /** The panel's balloons take a fresh rectangle: the panel itself moved, so the old ones no longer sit on it. */
  freshRects: boolean;
  /** Derive removes the script balloons whose line is gone; letter does not. */
  removeStale: boolean;
  /** 0-based: letter only this line of the panel. */
  only?: number;
}

function letterPanel(panel: Panel, lines: readonly ScriptLine[], context: LetterContext, taken: Set<string>, options: LetterPanelOptions): PanelLettering {
  const covered = new Map<string, DialogueCoverage>();
  for (const entry of panel.script ?? []) {
    if (isMine(entry, context.docId) && entry.balloonId !== undefined) covered.set(entry.balloonId, entry);
  }
  // The panel's script balloons in reading order, which is the order the lines are paired in.
  const mine = panel.balloons.filter((b) => covered.has(b.id));
  const balloons = panel.balloons.map((b) => ({ ...b }));
  const entries: DialogueCoverage[] = [];
  let placed = 0;
  let updated = 0;
  const replaced = new Set<string>();

  const indexes = options.only === undefined ? lines.map((_, k) => k) : [options.only];
  for (const k of indexes) {
    const line = lines[k];
    if (line === undefined) continue;
    const speaker = line.speakerName === undefined ? undefined : context.speakerId(line.speakerName);
    const pair = mine[k];
    const anchor = captureAnchor(context.body, line.from, line.to, context.revision);
    let balloonId: string;
    if (pair !== undefined) {
      const target = balloons.find((b) => b.id === pair.id) as Balloon;
      const before = JSON.stringify([target.kind, target.text, target.offPanel ?? false, target.speaker ?? null]);
      target.kind = line.kind;
      target.text = line.text;
      if (line.offPanel) target.offPanel = true;
      else delete target.offPanel;
      if (speaker !== undefined) target.speaker = speaker;
      else if (line.speakerName === undefined) delete target.speaker;
      if (options.freshRects) {
        target.rect = defaultBalloonRect(panel.rect, k, lines.length, context.readingDirection);
        delete target.tail;
      }
      if (before !== JSON.stringify([target.kind, target.text, target.offPanel ?? false, target.speaker ?? null])) updated += 1;
      balloonId = target.id;
      replaced.add(target.id);
    } else {
      const id = mintBalloonId(taken, context.randomBytes);
      taken.add(id);
      const fresh: Balloon = {
        id,
        kind: line.kind,
        text: line.text,
        rect: defaultBalloonRect(panel.rect, k, lines.length, context.readingDirection),
      };
      if (speaker !== undefined) fresh.speaker = speaker;
      if (line.offPanel) fresh.offPanel = true;
      balloons.push(fresh);
      balloonId = id;
      placed += 1;
    }
    if (anchor !== undefined) entries.push({ kind: 'comic-script-line', docId: context.docId, anchor, balloonId });
  }

  let removed = 0;
  let kept = balloons;
  if (options.removeStale && options.only === undefined) {
    const gone = new Set(mine.slice(lines.length).map((b) => b.id));
    kept = balloons.filter((b) => !gone.has(b.id));
    removed = balloons.length - kept.length;
    for (const id of gone) replaced.add(id);
  }

  // A derive re-letters the whole panel, so none of this script's old entries survive it. A letter keeps the entries of the balloons it
  // did not touch, which is what lets the coverage check go on seeing a balloon whose line has left the script.
  const keeps = (entry: DialogueCoverage): boolean => {
    if (!isMine(entry, context.docId)) return true;
    if (options.removeStale && options.only === undefined) return false;
    return entry.balloonId === undefined ? options.only !== undefined : !replaced.has(entry.balloonId);
  };
  const script = [...(panel.script ?? []).filter(keeps), ...entries];
  const next: Panel = { ...panel, balloons: kept };
  if (script.length > 0) next.script = script;
  else delete next.script;
  return { panel: next, placed, updated, removed };
}

function takenIds(page: ComicPage): Set<string> {
  const taken = new Set<string>();
  for (const panel of page.panels) {
    taken.add(panel.id);
    for (const balloon of panel.balloons) taken.add(balloon.id);
  }
  return taken;
}

// ---------------------------------------------------------------- derive

export interface DeriveInput extends ScriptSource {
  book: Pick<ComicBookSettings, 'readingDirection' | 'pageSize'>;
  /** The book's pages in binder order, loaded tolerantly. */
  pages: readonly ComicPage[];
  speakerId?: (speakerName: string) => string | undefined;
  randomBytes?: RandomBytes;
}

export interface DerivedPage {
  /** The page's number in the book, which is its script page's number. */
  number: number;
  /** The page is not in the book yet. */
  created: boolean;
  page: ComicPage;
  /** What deriving does to the page that was there: false when it already read exactly this. */
  changed: boolean;
  panels: number;
  /** Lines of the script on this page. */
  lines: number;
  placed: number;
  updated: number;
  removed: number;
}

export interface DeriveTotals {
  pages: number;
  created: number;
  changed: number;
  placed: number;
  updated: number;
  removed: number;
}

export type DerivePlan =
  | { ok: true; pages: DerivedPage[]; totals: DeriveTotals }
  | { ok: false; problems: DeriveProblem[] };

const hasPicture = (panel: Panel): boolean => panel.assetId !== undefined;

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What deriving the book's pages from its script does, page by page, without doing it. This is the preview as data: the apply
 * writes exactly `pages[].page`, and the same plan is what the descriptor validates, so a refusal comes before anything is written.
 */
export function planComicDerive(input: DeriveInput): DerivePlan {
  const script = parseComicScript(input.body);
  const problems: DeriveProblem[] = [];
  if (script.pages.length === 0) {
    return { ok: false, problems: [problem('noPages', 'noPages', 'The script has no page headers, so there is nothing to derive. Start a page with a line such as PAGE 1.')] };
  }
  const numbers = script.pages.map((p) => p.number);
  if (!numbers.every((n, i) => n === i + 1)) {
    return {
      ok: false,
      problems: [
        problem(
          'pageNumbers',
          'pageNumbers',
          'The script numbers its pages {numbers}. Derive needs them to run from 1 in order, with none repeated or skipped.',
          { numbers: numbers.join(', ') },
        ),
      ],
    };
  }

  const speakerId = input.speakerId ?? (() => undefined);
  const context: LetterContext = { docId: input.docId, body: input.body, revision: input.revision, readingDirection: input.book.readingDirection, speakerId };
  if (input.randomBytes !== undefined) context.randomBytes = input.randomBytes;
  const direction = input.book.readingDirection === 'rtl' ? 'rtl' : 'ltr';
  const derived: DerivedPage[] = [];

  for (const scriptPage of script.pages) {
    const existing = input.pages[scriptPage.number - 1];
    const count = Math.max(1, scriptPage.panels.length);
    if (count > MAX_PANELS_PER_PAGE) {
      problems.push(problem('tooManyPanels', 'tooManyPanels', 'Page {page} of the script has {count} panels, and a page holds at most {max}.', { page: scriptPage.number, count, max: MAX_PANELS_PER_PAGE }));
      continue;
    }
    const tooLong = scriptPage.panels.findIndex((p) => p.lines.length > MAX_BALLOONS_PER_PANEL);
    if (tooLong !== -1) {
      problems.push(problem('tooManyBalloons', 'tooManyBalloons', 'Panel {panel} on page {page} of the script has more lettering lines than a panel holds ({max}).', { page: scriptPage.number, panel: tooLong + 1, max: MAX_BALLOONS_PER_PANEL }));
      continue;
    }

    const built = buildPage(scriptPage, existing, count, direction, input, context);
    if ('problem' in built) problems.push(built.problem);
    else derived.push(built.page);
  }
  if (problems.length > 0) return { ok: false, problems };

  const totals: DeriveTotals = { pages: derived.length, created: 0, changed: 0, placed: 0, updated: 0, removed: 0 };
  for (const d of derived) {
    if (d.created) totals.created += 1;
    if (d.changed) totals.changed += 1;
    totals.placed += d.placed;
    totals.updated += d.updated;
    totals.removed += d.removed;
  }
  return { ok: true, pages: derived, totals };
}

function buildPage(
  scriptPage: ScriptPage,
  existing: ComicPage | undefined,
  count: number,
  direction: 'ltr' | 'rtl',
  input: DeriveInput,
  context: LetterContext,
): { page: DerivedPage } | { problem: DeriveProblem } {
  const number = scriptPage.number;
  const taken = existing === undefined ? new Set<string>() : takenIds(existing);
  let base: ComicPage;
  let relaid = false;

  if (existing === undefined) {
    const layout = templateForPanelCount(count);
    base = {
      size: input.book.pageSize,
      ...(layout === undefined ? {} : { layout }),
      panels: panelRectsFor(count, { size: input.book.pageSize, direction }).map((rect): Panel => {
        const id = mintPanelId(taken, input.randomBytes);
        taken.add(id);
        return { id, rect: [rect[0], rect[1], rect[2], rect[3]], border: 'thin', balloons: [] };
      }),
    };
  } else if (existing.panels.length === count) {
    base = { ...existing, panels: existing.panels.map((p) => ({ ...p })) };
  } else {
    if (existing.panels.some(hasPicture)) {
      return {
        problem: problem(
          'picturesInTheWay',
          'picturesInTheWay',
          'Page {page} holds a picture and has {have} panels, but the script gives it {want}. Moving the panels would misplace the picture, so change the script to match the page, or the page to match the script.',
          { page: number, have: existing.panels.length, want: count },
        ),
      };
    }
    // The panels that would be dropped may hold lettering the script knows nothing of; that is the writer's work, so it stops the derive.
    const ownBalloons = new Set<string>();
    for (const panel of existing.panels) for (const e of panel.script ?? []) if (isMine(e, input.docId) && e.balloonId !== undefined) ownBalloons.add(e.balloonId);
    const dropped = existing.panels.slice(count);
    if (dropped.some((panel) => panel.balloons.some((b) => !ownBalloons.has(b.id)))) {
      return {
        problem: problem(
          'dropsLettering',
          'dropsLettering',
          'Page {page} has {have} panels and the script gives it {want}, and the panels that would go hold lettering that is not from the script. Move that lettering, or add the panels to the script.',
          { page: number, have: existing.panels.length, want: count },
        ),
      };
    }
    const rects = panelRectsFor(count, { size: existing.size, direction });
    const layout = templateForPanelCount(count);
    const panels: Panel[] = [];
    for (let i = 0; i < count; i += 1) {
      const rect = rects[i] as Rect;
      const kept = existing.panels[i];
      if (kept !== undefined) panels.push({ ...kept, rect: [rect[0], rect[1], rect[2], rect[3]] });
      else {
        const id = mintPanelId(taken, input.randomBytes);
        taken.add(id);
        panels.push({ id, rect: [rect[0], rect[1], rect[2], rect[3]], border: 'thin', balloons: [] });
      }
    }
    base = { ...existing, panels };
    if (layout === undefined) delete base.layout;
    else base.layout = layout;
    relaid = true;
  }

  let placed = 0;
  let updated = 0;
  let removed = 0;
  let lines = 0;
  const panels = base.panels.map((panel, i) => {
    const scriptLines = scriptPage.panels[i]?.lines ?? [];
    lines += scriptLines.length;
    const result = letterPanel(panel, scriptLines, context, taken, { freshRects: relaid, removeStale: true });
    placed += result.placed;
    updated += result.updated;
    removed += result.removed;
    return result.panel;
  });
  const page: ComicPage = { ...base, panels };
  return {
    page: {
      number,
      created: existing === undefined,
      page,
      changed: existing === undefined || !sameValue(existing, page),
      panels: panels.length,
      lines,
      placed,
      updated,
      removed,
    },
  };
}

// ---------------------------------------------------------------- letter

export interface LetterInput extends ScriptSource {
  readingDirection: string;
  /** The page being lettered, and its number in the book (binder order, from 1). */
  page: ComicPage;
  pageNumber: number;
  /** 1-based: letter only this panel of the script page, or only one line of it with `line`. */
  panel?: number;
  line?: number;
  speakerId?: (speakerName: string) => string | undefined;
  randomBytes?: RandomBytes;
}

export type LetterPlan =
  | { ok: true; page: ComicPage; changed: boolean; placed: number; updated: number; lines: number }
  | { ok: false; problems: DeriveProblem[] };

/**
 * The lettering of one page, from the script page with the same number. It places a balloon for a line with none and updates
 * the balloon a line already has, and nothing else: it adds no panel, moves none, and never removes a balloon, so it is safe to
 * apply without asking. A page with fewer panels than its script page is refused, since a line cannot be lettered where there
 * is no panel; deriving the page is the way to make them.
 */
export function planComicLetter(input: LetterInput): LetterPlan {
  const script = parseComicScript(input.body);
  const scriptPage = script.pages.find((p) => p.number === input.pageNumber);
  if (scriptPage === undefined) {
    return { ok: false, problems: [problem('noScriptPage', 'noScriptPage', 'The script has no page {page}, so there is nothing to letter it from.', { page: input.pageNumber })] };
  }
  const wanted = scriptPage.panels.length;
  if (input.page.panels.length < wanted) {
    return {
      ok: false,
      problems: [
        problem(
          'panelsMissing',
          'panelsMissing',
          'Page {page} has {have} panels and the script gives it {want}. Derive the page from the script, or add the missing panels, and letter it again.',
          { page: input.pageNumber, have: input.page.panels.length, want: wanted },
        ),
      ],
    };
  }
  let only: { panel: number; line?: number } | undefined;
  if (input.panel !== undefined) {
    const target = scriptPage.panels[input.panel - 1];
    if (target === undefined) {
      return { ok: false, problems: [problem('noScriptPanel', 'noScriptPanel', 'Page {page} of the script has no panel {panel}.', { page: input.pageNumber, panel: input.panel })] };
    }
    if (input.line !== undefined && target.lines[input.line - 1] === undefined) {
      return { ok: false, problems: [problem('noScriptLine', 'noScriptLine', 'Panel {panel} on page {page} of the script has no lettering line {line}.', { page: input.pageNumber, panel: input.panel, line: input.line })] };
    }
    only = { panel: input.panel, ...(input.line === undefined ? {} : { line: input.line }) };
  }

  const context: LetterContext = {
    docId: input.docId,
    body: input.body,
    revision: input.revision,
    readingDirection: input.readingDirection,
    speakerId: input.speakerId ?? (() => undefined),
  };
  if (input.randomBytes !== undefined) context.randomBytes = input.randomBytes;
  const taken = takenIds(input.page);
  let placed = 0;
  let updated = 0;
  let lines = 0;
  const panels = input.page.panels.map((panel, i) => {
    const scriptLines = scriptPage.panels[i]?.lines ?? [];
    if (only !== undefined && only.panel !== i + 1) return panel;
    lines += only?.line === undefined ? scriptLines.length : 1;
    const result = letterPanel(panel, scriptLines, context, taken, {
      freshRects: false,
      removeStale: false,
      ...(only?.line === undefined ? {} : { only: only.line - 1 }),
    });
    placed += result.placed;
    updated += result.updated;
    return result.panel;
  });
  const page: ComicPage = { ...input.page, panels };
  return { ok: true, page, changed: !sameValue(input.page, page), placed, updated, lines };
}
