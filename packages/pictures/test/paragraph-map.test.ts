import { describe, expect, it } from 'vitest';

import { captureParagraphAnchor } from '../src/paragraphs.js';
import { LOOKALIKE_MARGIN, SIMILARITY_FLOOR, mapParagraphLinks, paragraphAnchorPort, type MapParagraphLinksInput, type ParagraphLinkRef } from '../src/paragraph-map.js';

/**
 * The eight drift witnesses of pictures.md §2.3, plus the edges the spec names: emoji and CRLF,
 * the diff timeout, a 100k-word fixture, a wrong placement failing and an honest orphaning passing.
 */

const P1 = 'The ferry left the harbour at dawn, and nobody waved.';
const P2 = 'Elena counted the gulls twice, because she did not trust the first count.';
const P3 = 'The lamp in the watchroom was lit all night, though no ship came.';

const BODY = `${P1}\n\n${P2}\n\n${P3}\n`;

function anchorAt(body: string, needle: string, revision = 1) {
  const anchor = captureParagraphAnchor(body, body.indexOf(needle), revision);
  if (anchor === undefined) throw new Error('no anchor');
  return anchor;
}

function run(oldBody: string, newBody: string, links: readonly ParagraphLinkRef[], revision = 2, extra: Partial<MapParagraphLinksInput> = {}) {
  return mapParagraphLinks({ docId: 'n_doc', oldBody, newBody, revision, links, ...extra });
}

function one(oldBody: string, newBody: string, needle: string, revision = 2) {
  const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(oldBody, needle, 1) };
  const mapping = run(oldBody, newBody, [link], revision);
  expect(mapping.results).toHaveLength(1);
  return mapping.results[0]!;
}

describe('the eight witnesses (pictures.md §2.3)', () => {
  it('edited in place: the anchor is recaptured at the same paragraph with the new revision', () => {
    const next = BODY.replace('nobody waved', 'everybody waved goodbye');
    const result = one(BODY, next, 'The ferry');
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') {
      expect(result.outcome.anchor.exact).toContain('everybody waved goodbye');
      expect(result.outcome.anchor.capturedRevision).toBe(2);
      expect(next.slice(result.outcome.anchor.from, result.outcome.anchor.to)).toBe(result.outcome.anchor.exact);
    }
  });

  it('moved: a paragraph carried elsewhere maps to its new position', () => {
    const next = `${P3}\n\n${P1}\n\n${P2}\n`;
    const result = one(BODY, next, 'The ferry');
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') expect(next.slice(result.outcome.anchor.from, result.outcome.anchor.to)).toBe(result.outcome.anchor.exact);
  });

  it('split: an inserted blank line inside the paragraph keeps the anchor on the surviving text', () => {
    const next = BODY.replace('because she did not trust', '\n\nbecause she did not trust');
    const result = one(BODY, next, 'Elena counted');
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') expect(next.slice(result.outcome.anchor.from, result.outcome.anchor.to)).toBe(result.outcome.anchor.exact);
  });

  it('deleted: the link is orphaned, kept with the captured quote, never dropped', () => {
    const next = `${P1}\n\n${P3}\n`;
    const result = one(BODY, next, 'Elena counted');
    expect(result.outcome.status).toBe('orphaned');
    if (result.outcome.status === 'orphaned') expect(result.outcome.anchor.exact).toBe(P2);
  });

  it('whole-document agent rewrite: paragraphs the rewrite kept are found again, marked moved', () => {
    const next = `New opening line the agent wrote.\n\n${P2}\n\nA closing line.\n`;
    const result = one(BODY, next, 'Elena counted');
    expect(['mapped', 'moved']).toContain(result.outcome.status);
    if (result.outcome.status !== 'orphaned') {
      expect(next.slice(result.outcome.anchor.from, result.outcome.anchor.to)).toBe(result.outcome.anchor.exact);
      expect(result.outcome.anchor.exact).toBe(P2);
    }
  });

  it('parallel lookalikes: deleting one of two identical paragraphs lands on the identical survivor, never on a different one', () => {
    const lookalikes = `The door was red.\n\nThe door was red.\n\n${P3}\n`;
    const anchor = anchorAt(lookalikes, 'The door', 1);
    const result = run(lookalikes, `The door was red.\n\n${P3}\n`, [{ linkId: 'l_1', anchor }], 2).results[0]!;
    expect(['mapped', 'moved']).toContain(result.outcome.status);
    if (result.outcome.status !== 'orphaned') {
      // The landed block is byte-identical to the anchored one (same block hash) — indistinguishable, so not a wrong placement.
      const landed = result.outcome.anchor;
      expect(landed.blockHash).toBe(anchor.blockHash);
    }
  });

  it('parallel lookalikes: the resolver refuses when two surviving blocks both match the captured quote (#7571)', () => {
    // Three long paragraphs sharing their first 200 characters (the quote); the anchored one is
    // rewritten away, and the two survivors score alike — within the margin — so nothing is guessed.
    const common = 'The same long opening sentence that all three paragraphs share, repeated verbatim here. '.repeat(3).trim(); // > 200 chars
    const tail = (letter: string): string => `${common} ${letter} unique ending.`;
    const body = `${tail('alpha')}\n\n${tail('beta')}\n\n${tail('gamma')}\n`;
    const anchor = anchorAt(body, common.slice(0, 40), 1);
    expect(anchor.exact).toHaveLength(200);
    const next = `${tail('beta')}\n\n${tail('gamma')}\n`;
    const result = run(body, next, [{ linkId: 'l_1', anchor }], 2).results[0]!;
    expect(result.outcome.status).toBe('orphaned');
    if (result.outcome.status === 'orphaned') expect(result.outcome.anchor.exact).toBe(anchor.exact);
  });

  it('repeated sentence start: a common opening line elsewhere does not capture the anchor', () => {
    const body = `It was the best of times.\n\n${P1}\n\nIt was the worst of times.\n`;
    const result = one(body, body.replace(P1, 'The ferry left the quay at dusk, and nobody waved.'), 'The ferry');
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') expect(result.outcome.anchor.exact).toContain('quay at dusk');
  });

  it('external rewrite: with no old body, the guarded resolver runs once and marks a found paragraph moved', () => {
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(BODY, 'Elena counted', 1) };
    const next = `Rewritten outside the app.\n\n${P2}\n`;
    const mapping = run('', next, [link], 5);
    const result = mapping.results[0]!;
    expect(result.outcome.status).toBe('moved');
    if (result.outcome.status === 'moved') {
      expect(result.outcome.anchor.exact).toBe(P2);
      expect(result.outcome.anchor.capturedRevision).toBe(5);
    }
  });
});

describe('edges the spec names', () => {
  it('emoji and CRLF: offsets stay UTF-16 and the mapping survives both', () => {
    const body = `Intro \u{1F30A} line.\r\n\r\n${P1}\r\n\r\nEnd \u{1F680}.\r\n`;
    const next = `Intro \u{1F30A} line.\r\n\r\n${P1} Nobody waved at all.\r\n\r\nEnd \u{1F680}.\r\n`;
    const result = one(body, next, 'The ferry');
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') {
      expect(next.slice(result.outcome.anchor.from, result.outcome.anchor.to)).toBe(result.outcome.anchor.exact);
      expect(result.outcome.anchor.exact).toContain('Nobody waved at all');
    }
  });

  it('timeout: a diff that gives up falls back to the guarded resolver for every link', () => {
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(BODY, 'The ferry', 1) };
    const mapping = run(BODY, `Replaced wholesale.\n\n${P1}\n`, [link], 2, { diffWorkCap: 1 });
    expect(mapping.diff).toBe('timeout');
    expect(mapping.results[0]!.outcome.status).toBe('moved');
  });

  it('a wrong placement fails: a link never lands on a paragraph that only shares the opening', () => {
    const body = `${P1}\n\nThe ferry left the harbour at noon, and the quay was empty.\n`;
    // The anchored paragraph is deleted outright; the surviving lookalike shares its opening but is
    // not similar enough to the old block, so the resolver orphans instead of landing on it.
    const next = `The ferry left the harbour at noon, and the quay was empty.\n`;
    const result = one(body, next, 'The ferry left the harbour at dawn');
    expect(result.outcome.status).toBe('orphaned');
  });

  it('honest orphaning passes: an unfindable paragraph is kept as orphaned, not dropped and not guessed', () => {
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(BODY, 'The lamp', 1) };
    const mapping = run(BODY, 'A single new paragraph.\n', [link], 2);
    const result = mapping.results[0]!;
    expect(result.outcome.status).toBe('orphaned');
    if (result.outcome.status === 'orphaned') expect(result.outcome.anchor.exact).toBe(P3);
  });

  it('an unchanged body recaptures at the new revision without a diff', () => {
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(BODY, 'Elena', 1) };
    const mapping = run(BODY, BODY, [link], 9);
    expect(mapping.diff).toBe('computed');
    const result = mapping.results[0]!;
    expect(result.outcome.status).toBe('mapped');
    if (result.outcome.status === 'mapped') expect(result.outcome.anchor.capturedRevision).toBe(9);
  });

  it('no links means no diff and no results', () => {
    expect(run(BODY, 'other', [], 2)).toEqual({ results: [], diff: 'computed' });
  });

  it('the port shape: paragraphAnchorPort().op is mapParagraphLinks', () => {
    const port = paragraphAnchorPort();
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(BODY, 'The ferry', 1) };
    const viaPort = port.op({ docId: 'n_doc', oldBody: BODY, newBody: BODY.replace('dawn', 'dusk'), revision: 2, links: [link] });
    expect(viaPort.results[0]!.outcome.status).toBe('mapped');
    expect(SIMILARITY_FLOOR).toBe(0.85);
    expect(LOOKALIKE_MARGIN).toBe(0.05);
  });

  it('100k words: one small edit maps quickly and a full rewrite falls back within the cap', () => {
    const paragraph = 'The tide keeps its own accounts, and it is never in a hurry to balance them. '.repeat(8).trim();
    const filler: string[] = [];
    let words = 0;
    for (let i = 0; words < 100_000; i += 1) {
      const line = `Paragraph ${i + 1} says something particular about the harbour, its lamps, and the ships that come in with the weather.`;
      filler.push(line);
      words += line.split(/\s+/).length;
    }
    const big = `${filler.join('\n\n')}\n\n${paragraph}\n\nClosing words here.\n`;
    expect(big.split(/\s+/).length).toBeGreaterThan(100_000);

    const started = Date.now();
    const edited = big.replace('its lamps, and', 'its lamps, all lit early, and');
    const link: ParagraphLinkRef = { linkId: 'l_1', anchor: anchorAt(big, 'The tide keeps', 1) };
    const mapped = run(big, edited, [link], 2);
    expect(mapped.diff).toBe('computed');
    expect(mapped.results[0]!.outcome.status).toBe('mapped');
    expect(Date.now() - started).toBeLessThan(20_000);

    const rewritten = Array.from({ length: filler.length }, (_, i) => `Totally different text for paragraph ${i + 1}, written by someone else entirely.`).join('\n\n');
    const started2 = Date.now();
    const fallback = run(big, `${rewritten}\n\n${paragraph}\n\nClosing words here.\n`, [link], 3);
    expect(fallback.diff).toBe('timeout');
    expect(fallback.results[0]!.outcome.status).toBe('moved');
    expect(Date.now() - started2).toBeLessThan(20_000);
  });
});
