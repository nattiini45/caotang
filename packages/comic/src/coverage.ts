/**
 * `comic.balloon-coverage` — comics.md §3.2. It works in both directions: every script line lettered, and every
 * balloon's script anchor still resolving. These are pure functions over a script body and the pages; the coherence
 * registry turns the drafts into findings.
 *
 * A script line counts as lettered when a panel's `script` entry resolves onto it and names a balloon that is still on
 * that panel, or, for a book lettered by hand against a script, when the panel at the same page and position holds a
 * balloon with the same text.
 */

import { excerpt, type ComicDraftFinding, type ComicPageInput } from './findings.js';
import { msg } from './message.js';
import { stripEmphasis } from './lettering.js';
import type { TextAnchor } from './model.js';
import { parseComicScript, type ScriptLine } from './script.js';

const CHECK = 'comic.balloon-coverage' as const;

export type AnchorResolver = (anchor: TextAnchor, body: string) => { from: number; to: number } | undefined;

/**
 * Where an anchor's text is now: at its offsets when it still reads the same there, else its only occurrence, else the
 * only occurrence that also has its recorded neighbours. Never a guess among several (edit-anchors.md §3's rule); the
 * editor's full ladder can be injected instead.
 */
export const resolveAnchorExact: AnchorResolver = (anchor, body) => {
  if (body.slice(anchor.from, anchor.to) === anchor.exact) return { from: anchor.from, to: anchor.to };
  const hits: number[] = [];
  for (let at = body.indexOf(anchor.exact); at !== -1; at = body.indexOf(anchor.exact, at + 1)) hits.push(at);
  if (hits.length === 1) return { from: hits[0] as number, to: (hits[0] as number) + anchor.exact.length };
  const near = hits.filter(
    (at) =>
      body.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix &&
      body.slice(at + anchor.exact.length, at + anchor.exact.length + anchor.suffix.length) === anchor.suffix,
  );
  return near.length === 1 ? { from: near[0] as number, to: (near[0] as number) + anchor.exact.length } : undefined;
};

export interface CoverageInput {
  /** The book's linked script document. */
  docId: string;
  body: string;
  pages: readonly ComicPageInput[];
  resolveAnchor?: AnchorResolver;
}

const normalize = (text: string): string => stripEmphasis(text).replace(/\s+/g, ' ').trim();

export function checkBalloonCoverage(input: CoverageInput): ComicDraftFinding[] {
  const resolve = input.resolveAnchor ?? resolveAnchorExact;
  const script = parseComicScript(input.body);
  const findings: ComicDraftFinding[] = [];

  interface Flat {
    pageNumber: number;
    panelIndex: number;
    lineIndex: number;
    line: ScriptLine;
    lettered: boolean;
  }
  const flat: Flat[] = [];
  for (const page of script.pages) {
    for (const panel of page.panels) {
      panel.lines.forEach((line, lineIndex) =>
        flat.push({ pageNumber: page.number, panelIndex: panel.index, lineIndex, line, lettered: false }),
      );
    }
  }

  for (const entry of input.pages) {
    entry.page.panels.forEach((panel, panelIndex) => {
      for (const [n, cover] of (panel.script ?? []).entries()) {
        const where = { pageId: entry.id, pageNumber: entry.number, panelId: panel.id, docId: cover.docId };
        const keyBase = `${CHECK}:${entry.id}:${panel.id}:${cover.balloonId ?? `cover${n}`}`;
        if (cover.docId !== input.docId) {
          findings.push({
            checkId: CHECK,
            code: 'staleDocument',
            severity: 'warning',
            key: `${keyBase}:document`,
            message: msg(
              'comic.coverage.staleDocument',
              'A line on page {page} was lettered from a script that is not the one this book uses.',
              { page: entry.number },
            ),
            nextAction: msg('comic.coverage.staleDocument.next', 'Letter the page again from the script this book uses.'),
            evidence: excerpt(cover.anchor.exact),
            where,
          });
          continue;
        }
        const range = resolve(cover.anchor, input.body);
        if (range === undefined) {
          findings.push({
            checkId: CHECK,
            code: 'staleAnchor',
            severity: 'warning',
            key: `${keyBase}:anchor`,
            message: msg(
              'comic.coverage.staleAnchor',
              'The script text behind a balloon on page {page} has changed or moved, so the balloon may be out of date.',
              { page: entry.number },
            ),
            nextAction: msg('comic.coverage.staleAnchor.next', 'Compare the balloon with the script and letter it again.'),
            evidence: excerpt(cover.anchor.exact),
            where: { ...where, ...(cover.balloonId === undefined ? {} : { balloonId: cover.balloonId }) },
          });
          continue;
        }
        const balloonThere = cover.balloonId !== undefined && panel.balloons.some((b) => b.id === cover.balloonId);
        if (cover.balloonId !== undefined && !balloonThere) {
          findings.push({
            checkId: CHECK,
            code: 'brokenBalloon',
            severity: 'warning',
            key: `${keyBase}:balloon`,
            message: msg(
              'comic.coverage.brokenBalloon',
              'A script line on page {page}, panel {panel} points at a balloon that is no longer on the panel.',
              { page: entry.number, panel: panelIndex + 1 },
            ),
            nextAction: msg('comic.coverage.brokenBalloon.next', 'Letter the line again in a balloon on this panel.'),
            evidence: excerpt(cover.anchor.exact),
            where: { ...where, balloonId: cover.balloonId, scriptRange: range },
          });
        }
        if (balloonThere) {
          for (const f of flat) {
            if (f.line.from < range.to && range.from < f.line.to) f.lettered = true;
          }
        }
      }
    });
  }

  for (const f of flat) {
    if (f.lettered) continue;
    const page = input.pages.find((p) => p.number === f.pageNumber);
    const panel = page?.page.panels[f.panelIndex - 1];
    const wanted = normalize(f.line.text);
    if (panel !== undefined && panel.balloons.some((b) => normalize(b.text) === wanted)) continue;
    const who = f.line.speakerName ?? (f.line.kind === 'sfx' ? 'SFX' : 'CAPTION');
    findings.push({
      checkId: CHECK,
      code: 'unletteredLine',
      severity: 'warning',
      key: `${CHECK}:${input.docId}:${f.pageNumber}.${f.panelIndex}.${f.lineIndex}`,
      message: msg(
        'comic.coverage.unletteredLine',
        'The script line for {speaker} on page {page}, panel {panel} has no balloon.',
        { speaker: who, page: f.pageNumber, panel: f.panelIndex },
      ),
      nextAction: msg(
        'comic.coverage.unletteredLine.next',
        'Letter it in a balloon on that panel, or remove the line from the script.',
      ),
      evidence: excerpt(f.line.text),
      where: {
        docId: input.docId,
        pageNumber: f.pageNumber,
        ...(page === undefined ? {} : { pageId: page.id }),
        ...(panel === undefined ? {} : { panelId: panel.id }),
        scriptRange: { from: f.line.from, to: f.line.to },
      },
    });
  }
  return findings;
}
