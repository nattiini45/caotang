// i18n: package-refs
/**
 * The comic checks — [comics.md §4 and §2.1](../../../../docs/architecture/comics.md), issue D9 (#173):
 * the lint `comic.balloon-density`, `comic.em-dash` and `comic.caps-policy`, and `comic.balloon-coverage` (§3.2), which
 * reads the book's linked script as well as its pages.
 *
 * `@caotang/comic` computes the drafts (warnings only, never a rewrite of the writer's text); this file registers
 * them in the closed registry (coherence.md §5.4) and turns each `ComicDraftFinding` into a `DraftFinding`:
 *
 * - the fact group is the comic draft's stable `key` lowercased, so the upsert's identity (checkId + factGroup +
 *   quoted docs, §6.1) keeps matching across runs while the balloon is unchanged, and a dismissal keeps matching;
 * - a lint finding quotes no document: a balloon's text is structure on a `comic-page` node, not a passage in a body
 *   projection, so `evidence` is empty the way a shot's `duration-missing` finding quotes none — the page and panel
 *   numbers are in the message, the balloon and panel ids in the fact group;
 * - the English `message` is the comic ref's sentence plus its next action; the `messageRef` beside it restates both
 *   under a `coherence.*` id so the package-refs extractor (tools/package-refs-extractor.ts) lists them in the app
 *   catalogue. The wording mirrors `lint.ts`'s `comic.*` refs — keep the two in step.
 */

import type { MessageRef } from '@caotang/i18n';
import {
  checkBalloonCoverage,
  checkBalloonDensity,
  checkCapsPolicy,
  checkEmDash,
  renderMessage,
  type ComicCheckId,
  type ComicDraftFinding,
  type LintOptions,
} from '@caotang/comic';

import type { CheckInput, CheckOutput, DraftFinding } from './common.js';

/** The three lint ids, which read only the pages. `comic.balloon-coverage` has its own entry below. */
type ComicLintId = Exclude<ComicCheckId, 'comic.balloon-coverage'>;

/** The catalogue template for one draft code, with its named values. Unknown codes are not registered (§5.4). */
function messageRefOf(draft: ComicDraftFinding): MessageRef | undefined {
  const values = draft.message.values ?? {};
  switch (draft.code) {
    case 'balloon':
      return {
        id: 'coherence.comic.densityBalloon',
        message:
          'A balloon on page {page}, panel {panel} has {words} words. Balloons read best at {limit} words or fewer. Cut the balloon, or split it into two.',
        values: {
          page: values['page'] ?? 0,
          panel: values['panel'] ?? 0,
          words: values['words'] ?? 0,
          limit: values['limit'] ?? 0,
        },
      };
    case 'panel':
      return {
        id: 'coherence.comic.densityPanel',
        message:
          'Panel {panel} on page {page} carries {words} words of lettering. Panels read best at {limit} words or fewer. Move some of the lettering to another panel, or cut it.',
        values: {
          page: values['page'] ?? 0,
          panel: values['panel'] ?? 0,
          words: values['words'] ?? 0,
          limit: values['limit'] ?? 0,
        },
      };
    case 'emDash':
      return {
        id: 'coherence.comic.emDash',
        message:
          'A balloon on page {page}, panel {panel} uses an em dash. Comic lettering uses a double dash (--). Replace the em dash with two hyphens.',
        values: { page: values['page'] ?? 0, panel: values['panel'] ?? 0 },
      };
    case 'esszettBecomesSS':
      return {
        id: 'coherence.comic.esszettAsSS',
        message:
          'A balloon on page {page}, panel {panel} has a ß, which is lettered as SS in capitals. Keep SS, or turn on the capital ẞ in the book settings.',
        values: { page: values['page'] ?? 0, panel: values['panel'] ?? 0 },
      };
    case 'unletteredLine':
      return {
        id: 'coherence.comic.coverageUnlettered',
        message:
          'The script line for {speaker} on page {page}, panel {panel} has no balloon. Letter it in a balloon on that panel, or remove the line from the script.',
        values: { speaker: values['speaker'] ?? '', page: values['page'] ?? 0, panel: values['panel'] ?? 0 },
      };
    case 'staleAnchor':
      return {
        id: 'coherence.comic.coverageStaleAnchor',
        message:
          'The script text behind a balloon on page {page} has changed or moved, so the balloon may be out of date. Compare the balloon with the script and letter it again.',
        values: { page: values['page'] ?? 0 },
      };
    case 'brokenBalloon':
      return {
        id: 'coherence.comic.coverageBrokenBalloon',
        message:
          'A script line on page {page}, panel {panel} points at a balloon that is no longer on the panel. Letter the line again in a balloon on this panel.',
        values: { page: values['page'] ?? 0, panel: values['panel'] ?? 0 },
      };
    case 'staleDocument':
      return {
        id: 'coherence.comic.coverageStaleDocument',
        message:
          'A line on page {page} was lettered from a script that is not the one this book uses. Letter the page again from the script this book uses.',
        values: { page: values['page'] ?? 0 },
      };
    default:
      return undefined;
  }
}

/** One comic draft as a coherence draft. */
function toDraft(draft: ComicDraftFinding): DraftFinding | undefined {
  const messageRef = messageRefOf(draft);
  if (messageRef === undefined) return undefined;
  return {
    checkId: draft.checkId,
    type: draft.code,
    severity: draft.severity,
    // The draft key is `checkId:code:page:panel:balloon`, one stable string, so it stands as the §4.2 entity|attribute key.
    factGroup: draft.key.toLowerCase(),
    evidence: [],
    message: `${renderMessage(draft.message)} ${renderMessage(draft.nextAction)}`,
    messageRef,
  };
}

/**
 * The registry entry for one comic lint id: runs that lint of `@caotang/comic` over every book the snapshot read
 * and maps the drafts. A project with no comic book evaluates nothing; the run note says how much was read, so a
 * check that had little to read does not look like one that found nothing.
 */
export function checkComicLint(id: ComicLintId): (input: CheckInput) => CheckOutput {
  return (input) => {
    const books = input.comics ?? [];
    if (books.length === 0) return { drafts: [], notes: [] };
    const drafts: DraftFinding[] = [];
    let pageCount = 0;
    for (const book of books) {
      pageCount += book.pages.length;
      const options: LintOptions = {
        book: { capsTransform: book.settings.capsTransform, esszett: book.settings.esszett },
        ...(input.language !== undefined ? { language: input.language } : {}),
      };
      const found =
        id === 'comic.balloon-density'
          ? checkBalloonDensity(book.pages, options)
          : id === 'comic.em-dash'
            ? checkEmDash(book.pages)
            : checkCapsPolicy(book.pages, options);
      for (const draft of found) {
        const mapped = toDraft(draft);
        if (mapped !== undefined) drafts.push(mapped);
      }
    }
    return { drafts, notes: [`comic lint read ${books.length} book(s), ${pageCount} page(s)`] };
  };
}

/**
 * `comic.balloon-coverage`: both directions between a book's linked script and its balloons (comics.md §3.2). Like the lint it
 * quotes no document, so a finding is kept by any scope and a research script is read as well as a manuscript one: the script line
 * is named by speaker, page and panel in the message, and by the draft's key (the line's page, panel and position) in the fact group.
 *
 * A book with no linked script is not evaluated, because a pages-first book has nothing to cover and silence there is not a pass;
 * the note says how many were left out and why. A link whose document is gone is not evaluated either, and is never re-matched
 * by title (§2): the book view shows the broken link.
 */
export function checkComicCoverage(input: CheckInput): CheckOutput {
  const books = input.comics ?? [];
  if (books.length === 0) return { drafts: [], notes: [] };
  const drafts: DraftFinding[] = [];
  let read = 0;
  let pageCount = 0;
  let unlinked = 0;
  let broken = 0;
  for (const book of books) {
    if (book.settings.scriptDocId === undefined) {
      unlinked += 1;
      continue;
    }
    if (book.script === undefined) {
      broken += 1;
      continue;
    }
    read += 1;
    pageCount += book.pages.length;
    for (const draft of checkBalloonCoverage({ docId: book.script.docId, body: book.script.body, pages: book.pages })) {
      const mapped = toDraft(draft);
      if (mapped !== undefined) drafts.push(mapped);
    }
  }
  const notes: string[] = [];
  if (read > 0) notes.push(`comic coverage read ${read} book(s) against their scripts, ${pageCount} page(s)`);
  if (unlinked > 0) notes.push(`comic coverage skipped ${unlinked} book(s) with no linked script`);
  if (broken > 0) notes.push(`comic coverage skipped ${broken} book(s) whose linked script is no longer in the project`);
  return { drafts, notes };
}