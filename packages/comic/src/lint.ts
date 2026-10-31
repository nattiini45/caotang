/**
 * `comic.balloon-density` and the lettering lint — comics.md §4, issue D9. Warnings only: the craft guideline is
 * approximate and nothing here rewrites the writer's text.
 */

import { excerpt, type ComicDraftFinding, type ComicPageInput } from './findings.js';
import { findEmDashes, stripEmphasis } from './lettering.js';
import { msg } from './message.js';
import type { ComicBookSettings } from './model.js';
import { countWords } from './words.js';

/** More than this many words in one balloon draws a warning; exactly this many does not. */
export const MAX_WORDS_PER_BALLOON = 25;
export const MAX_WORDS_PER_PANEL = 50;

export interface LintOptions {
  book: Pick<ComicBookSettings, 'capsTransform' | 'esszett'>;
  /** The project's language, a BCP 47 tag. */
  language?: string;
  balloonWordLimit?: number;
  panelWordLimit?: number;
}

const HAN_OR_KANA = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

export function checkBalloonDensity(pages: readonly ComicPageInput[], options: LintOptions): ComicDraftFinding[] {
  const balloonLimit = options.balloonWordLimit ?? MAX_WORDS_PER_BALLOON;
  const panelLimit = options.panelWordLimit ?? MAX_WORDS_PER_PANEL;
  const out: ComicDraftFinding[] = [];
  for (const entry of pages) {
    entry.page.panels.forEach((panel, panelIndex) => {
      let total = 0;
      for (const balloon of panel.balloons) {
        const words = countWords(stripEmphasis(balloon.text));
        total += words;
        if (words > balloonLimit) {
          out.push({
            checkId: 'comic.balloon-density',
            code: 'balloon',
            severity: 'warning',
            key: `comic.balloon-density:balloon:${entry.id}:${panel.id}:${balloon.id}`,
            message: msg(
              'comic.density.balloon',
              'A balloon on page {page}, panel {panel} has {words} words. Balloons read best at {limit} words or fewer.',
              { page: entry.number, panel: panelIndex + 1, words, limit: balloonLimit },
            ),
            nextAction: msg('comic.density.balloon.next', 'Cut the balloon, or split it into two.'),
            evidence: excerpt(balloon.text),
            where: { pageId: entry.id, pageNumber: entry.number, panelId: panel.id, balloonId: balloon.id },
          });
        }
      }
      if (total > panelLimit) {
        out.push({
          checkId: 'comic.balloon-density',
          code: 'panel',
          severity: 'warning',
          key: `comic.balloon-density:panel:${entry.id}:${panel.id}`,
          message: msg(
            'comic.density.panel',
            'Panel {panel} on page {page} carries {words} words of lettering. Panels read best at {limit} words or fewer.',
            { page: entry.number, panel: panelIndex + 1, words: total, limit: panelLimit },
          ),
          nextAction: msg('comic.density.panel.next', 'Move some of the lettering to another panel, or cut it.'),
          evidence: `${total} words`,
          where: { pageId: entry.id, pageNumber: entry.number, panelId: panel.id },
        });
      }
    });
  }
  return out;
}

/**
 * An em dash in balloon text. Lettering uses a double dash. Text with Han or Kana is left alone, because the long dash
 * is ordinary punctuation there and not the typographic slip the rule is about.
 */
export function checkEmDash(pages: readonly ComicPageInput[]): ComicDraftFinding[] {
  const out: ComicDraftFinding[] = [];
  for (const entry of pages) {
    entry.page.panels.forEach((panel, panelIndex) => {
      for (const balloon of panel.balloons) {
        if (HAN_OR_KANA.test(balloon.text)) continue;
        const hits = findEmDashes(balloon.text);
        const first = hits[0];
        if (first === undefined) continue;
        out.push({
          checkId: 'comic.em-dash',
          code: 'emDash',
          severity: 'warning',
          key: `comic.em-dash:${entry.id}:${panel.id}:${balloon.id}`,
          message: msg(
            'comic.lettering.emDash',
            'A balloon on page {page}, panel {panel} uses an em dash. Comic lettering uses a double dash (--).',
            { page: entry.number, panel: panelIndex + 1 },
          ),
          nextAction: msg('comic.lettering.emDash.next', 'Replace the em dash with two hyphens.'),
          evidence: excerpt(balloon.text.slice(Math.max(0, first.from - 20), first.to + 20)),
          where: { pageId: entry.id, pageNumber: entry.number, panelId: panel.id, balloonId: balloon.id },
        });
      }
    });
  }
  return out;
}

/**
 * The caps policy is the book's: with `capsTransform` off the lettering is mixed case on purpose and nothing is
 * reported. With it on, mixed case in the source is fine (it is converted for display) and caseless scripts have
 * nothing to convert; the one thing worth a heads-up is ß, which letters as SS unless the book opts into ẞ.
 */
export function checkCapsPolicy(pages: readonly ComicPageInput[], options: LintOptions): ComicDraftFinding[] {
  if (!options.book.capsTransform || options.book.esszett) return [];
  const out: ComicDraftFinding[] = [];
  for (const entry of pages) {
    entry.page.panels.forEach((panel, panelIndex) => {
      for (const balloon of panel.balloons) {
        if (!balloon.text.includes('ß')) continue;
        out.push({
          checkId: 'comic.caps-policy',
          code: 'esszettBecomesSS',
          severity: 'info',
          key: `comic.caps-policy:esszett:${entry.id}:${panel.id}:${balloon.id}`,
          message: msg(
            'comic.lettering.esszett',
            'A balloon on page {page}, panel {panel} has a ß, which is lettered as SS in capitals.',
            { page: entry.number, panel: panelIndex + 1 },
          ),
          nextAction: msg(
            'comic.lettering.esszett.next',
            'Keep SS, or turn on the capital ẞ in the book settings.',
          ),
          evidence: excerpt(balloon.text),
          where: { pageId: entry.id, pageNumber: entry.number, panelId: panel.id, balloonId: balloon.id },
        });
      }
    });
  }
  return out;
}

export function lintComic(pages: readonly ComicPageInput[], options: LintOptions): ComicDraftFinding[] {
  return [...checkBalloonDensity(pages, options), ...checkEmDash(pages), ...checkCapsPolicy(pages, options)];
}
