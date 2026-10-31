/**
 * The comic lint checks in the closed registry (comics.md §4, issue D9 #173; coherence.md §5.4):
 * `comic.balloon-density`, `comic.em-dash` and `comic.caps-policy`, computed by `@caotang/comic` over the books the
 * snapshot reads and registered as coherence findings, so the normal lifecycle — upsert, dismissal, fixed, clearing —
 * and the MessageRef localisation apply to them unchanged.
 *
 * The fixture table pins the thresholds at their boundaries (25/26 words per balloon, 50/51 per panel), the per-book
 * caps policy, the German ß behavior, Han and right-to-left text, an empty panel, combined warnings on one balloon,
 * stable ids across scans and the dismissal round trip.
 */

import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_CHECKS,
  DETERMINISTIC_CHECK_IDS,
  DETERMINISTIC_CHECK_LABELS,
  assembleInput,
  dismissFinding,
  emptyCoherenceFile,
  markFindingFixed,
  reopenFinding,
  runChecks,
  runDeterministic,
  type CoherenceFile,
  type DraftFinding,
} from '../src/index.js';
import { addDocument, addNode, type ProjectState } from '@caotang/store';

import { LATER, NOW, buildState, detect } from './fixtures.js';

const COMIC_IDS = ['comic.balloon-density', 'comic.em-dash', 'comic.caps-policy'] as const;

const words = (n: number, word = 'word'): string => Array.from({ length: n }, () => word).join(' ');

const balloon = (id: string, text: string) => ({ id, kind: 'speech', text, rect: [0.1, 0.1, 0.3, 0.15] });
const panel = (id: string, balloons: readonly unknown[]) => ({ id, rect: [0, 0, 1, 0.5], balloons });

interface PageSpec {
  readonly id: string;
  readonly panels: readonly unknown[];
}

/** A comic book in the tree the way `comic.createBook` writes one: a `comic` folder, its `comic-page` children. */
function addBook(
  state: ProjectState,
  book: { readonly id: string; readonly settings?: Record<string, unknown>; readonly pages: readonly PageSpec[] },
): void {
  const node = addNode(state, { parentId: 'manuscript', title: book.id, type: 'folder', kind: 'comic', id: book.id, now: NOW });
  node.comic = {
    readingDirection: 'ltr',
    letteringFace: 'comic-neue',
    capsTransform: true,
    esszett: false,
    pageSize: 'us-comic',
    ...book.settings,
  };
  for (const page of book.pages) {
    const pageNode = addNode(state, { parentId: book.id, title: page.id, type: 'comic-page', id: page.id, now: NOW });
    pageNode.comicPage = { size: 'us-comic', panels: page.panels };
  }
}

/** A project with one manuscript scene (so the run has a document) and the given comic book. */
function comicState(book: Parameters<typeof addBook>[1]): ProjectState {
  const state = buildState({ scenes: [{ id: 'scene', title: 'Scene', body: 'The harbour was quiet.' }] });
  addBook(state, book);
  return state;
}

function run(state: ProjectState, file: CoherenceFile, ids: readonly (typeof COMIC_IDS)[number][]) {
  const { input } = assembleInput(state, file, { detector: detect });
  return runChecks(input, ids);
}

function full(state: ProjectState, file: CoherenceFile, now: Date = NOW) {
  return runDeterministic(state, file, { scope: { mode: 'full' }, now, detector: detect });
}

const onePage = (panels: readonly unknown[]) => ({ id: 'n_book', pages: [{ id: 'n_p1', panels }] });

describe('comic.balloon-density in the registry (comics.md §4)', () => {
  it('is one of the closed ids and runs with the others', () => {
    for (const id of COMIC_IDS) expect(DETERMINISTIC_CHECK_IDS).toContain(id);
    const state = comicState(onePage([panel('pn_a', [balloon('bl_a', words(26))])]));
    const out = run(state, emptyCoherenceFile(), [...COMIC_IDS]);
    expect(out.drafts.map((draft) => draft.checkId)).toEqual(['comic.balloon-density']);
  });

  it('does not warn at 25 words in a balloon and warns at 26, keyed by the draft key', () => {
    const at25 = run(comicState(onePage([panel('pn_a', [balloon('bl_a', words(25))])])), emptyCoherenceFile(), ['comic.balloon-density']);
    expect(at25.drafts).toEqual([]);
    const at26 = run(comicState(onePage([panel('pn_a', [balloon('bl_a', words(26))])])), emptyCoherenceFile(), ['comic.balloon-density']);
    expect(at26.drafts).toHaveLength(1);
    const [draft] = at26.drafts;
    expect(draft).toMatchObject({
      checkId: 'comic.balloon-density',
      type: 'balloon',
      severity: 'warning',
      factGroup: 'comic.balloon-density:balloon:n_p1:pn_a:bl_a',
      evidence: [],
    });
    expect(draft?.message).toContain('26 words');
    expect(draft?.message).toContain('Cut the balloon, or split it into two.');
    expect(draft?.messageRef).toEqual({
      id: 'coherence.comic.densityBalloon',
      message: expect.stringContaining('{words}'),
      values: { page: 1, panel: 1, words: 26, limit: 25 },
    });
  });

  it('does not warn at 50 words in a panel and warns at 51, beside the balloon warning', () => {
    const at50 = run(
      comicState(onePage([panel('pn_a', [balloon('bl_a', words(25)), balloon('bl_b', words(25))])])),
      emptyCoherenceFile(),
      ['comic.balloon-density'],
    );
    expect(at50.drafts).toEqual([]);
    const at51 = run(
      comicState(onePage([panel('pn_a', [balloon('bl_a', words(25)), balloon('bl_b', words(26))])])),
      emptyCoherenceFile(),
      ['comic.balloon-density'],
    );
    expect(at51.drafts.map((draft) => draft.type).sort()).toEqual(['balloon', 'panel']);
    const panelDraft = at51.drafts.find((draft) => draft.type === 'panel');
    expect(panelDraft?.factGroup).toBe('comic.balloon-density:panel:n_p1:pn_a');
    expect(panelDraft?.messageRef?.id).toBe('coherence.comic.densityPanel');
    // Three balloons of 20, 20 and 11 words: over the panel limit, under each balloon's.
    const spread = run(
      comicState(onePage([panel('pn_a', [balloon('bl_a', words(20)), balloon('bl_b', words(20)), balloon('bl_c', words(11))])])),
      emptyCoherenceFile(),
      ['comic.balloon-density'],
    );
    expect(spread.drafts.map((draft) => draft.type)).toEqual(['panel']);
  });

  it('counts per panel, not per page, and ignores emphasis markers', () => {
    const state = comicState({
      id: 'n_book',
      pages: [
        { id: 'n_p1', panels: [panel('pn_a', [balloon('bl_a', words(30))])] },
        { id: 'n_p2', panels: [panel('pn_b', [balloon('bl_b', words(30))])] },
      ],
    });
    const out = run(state, emptyCoherenceFile(), ['comic.balloon-density']);
    expect(out.drafts.map((draft) => draft.type)).toEqual(['balloon', 'balloon']);
    const emphasis = run(
      comicState(onePage([panel('pn_a', [balloon('bl_a', `**${words(25)}**`)])])),
      emptyCoherenceFile(),
      ['comic.balloon-density'],
    );
    expect(emphasis.drafts).toEqual([]);
  });

  it('counts Han text by word and right-to-left text by its spaces', () => {
    const han = run(comicState(onePage([panel('pn_a', [balloon('bl_a', '你好世界'.repeat(30))])])), emptyCoherenceFile(), ['comic.balloon-density']);
    expect(han.drafts.map((draft) => draft.type)).toEqual(['balloon', 'panel']);
    const arabic26 = Array.from({ length: 26 }, () => 'مرحبا').join(' ');
    const rtl = run(comicState(onePage([panel('pn_a', [balloon('bl_a', arabic26)])])), emptyCoherenceFile(), ['comic.balloon-density']);
    expect(rtl.drafts.map((draft) => draft.type)).toEqual(['balloon']);
    const rtl25 = run(
      comicState(onePage([panel('pn_a', [balloon('bl_a', arabic26.split(' ').slice(0, 25).join(' '))])])),
      emptyCoherenceFile(),
      ['comic.balloon-density'],
    );
    expect(rtl25.drafts).toEqual([]);
  });

  it('warns for an empty panel never, and for an empty balloon never, and says how much it read', () => {
    const state = comicState({ id: 'n_book', pages: [{ id: 'n_p1', panels: [panel('pn_a', []), panel('pn_b', [balloon('bl_a', '')])] }] });
    const out = run(state, emptyCoherenceFile(), COMIC_IDS);
    expect(out.drafts).toEqual([]);
    expect(out.notes).toContain('comic lint read 1 book(s), 1 page(s)');
    const noPages = comicState({ id: 'n_book', pages: [] });
    expect(run(noPages, emptyCoherenceFile(), COMIC_IDS).notes).toContain('comic lint read 1 book(s), 0 page(s)');
  });

  it('evaluates nothing when the project has no comic book', () => {
    const state = buildState({ scenes: [{ id: 'scene', title: 'Scene', body: 'Prose only.' }] });
    const out = run(state, emptyCoherenceFile(), COMIC_IDS);
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual([]);
  });
});

describe('comic.em-dash in the registry (comics.md §4)', () => {
  it('flags an em dash in a balloon, with the double-dash remedy as the message ref', () => {
    const out = run(comicState(onePage([panel('pn_a', [balloon('bl_a', 'Wait — no. Stop.')])])), emptyCoherenceFile(), ['comic.em-dash']);
    expect(out.drafts).toHaveLength(1);
    const [draft] = out.drafts;
    expect(draft).toMatchObject({ checkId: 'comic.em-dash', type: 'emDash', severity: 'warning', evidence: [] });
    expect(draft?.message).toContain('double dash');
    expect(draft?.messageRef).toEqual({
      id: 'coherence.comic.emDash',
      message: expect.stringContaining('{page}'),
      values: { page: 1, panel: 1 },
    });
    // A double dash is the lettering convention and is not flagged.
    expect(run(comicState(onePage([panel('pn_a', [balloon('bl_a', 'Wait -- no.')])])), emptyCoherenceFile(), ['comic.em-dash']).drafts).toEqual([]);
  });

  it('leaves Han and kana text alone, flags right-to-left text, and flags once per balloon', () => {
    const mixed = run(
      comicState(onePage([panel('pn_a', [balloon('bl_han', '你好——世界'), balloon('bl_a', 'a — b — c'), balloon('bl_rtl', 'مرحبا — بالعالم')])])),
      emptyCoherenceFile(),
      ['comic.em-dash'],
    );
    expect(mixed.drafts.map((draft) => draft.factGroup)).toEqual([
      'comic.em-dash:n_p1:pn_a:bl_a',
      'comic.em-dash:n_p1:pn_a:bl_rtl',
    ]);
    const kana = run(comicState(onePage([panel('pn_a', [balloon('bl_a', 'こんにちは—さようなら')])])), emptyCoherenceFile(), ['comic.em-dash']);
    expect(kana.drafts).toEqual([]);
  });
});

describe('comic.caps-policy in the registry (comics.md §4)', () => {
  const strasse = onePage([panel('pn_a', [balloon('bl_a', 'Die Straße.')])]);

  it('tells the writer a ß will be lettered as SS in a caps book', () => {
    const out = run(comicState(strasse), emptyCoherenceFile(), ['comic.caps-policy']);
    expect(out.drafts).toHaveLength(1);
    const [draft] = out.drafts;
    expect(draft).toMatchObject({ checkId: 'comic.caps-policy', type: 'esszettBecomesSS', severity: 'info' });
    expect(draft?.messageRef?.id).toBe('coherence.comic.esszettAsSS');
    expect(draft?.message).toContain('ẞ');
  });

  it('says nothing when the book keeps mixed case or opts into ẞ', () => {
    expect(run(comicState({ ...strasse, settings: { capsTransform: false } }), emptyCoherenceFile(), ['comic.caps-policy']).drafts).toEqual([]);
    expect(run(comicState({ ...strasse, settings: { esszett: true } }), emptyCoherenceFile(), ['comic.caps-policy']).drafts).toEqual([]);
  });

  it('says nothing about caseless scripts in a caps book', () => {
    const mixed = onePage([panel('pn_a', [balloon('bl_a', '你好，世界'), balloon('bl_b', 'مرحبا'), balloon('bl_c', 'שלום')])]);
    expect(run(comicState(mixed), emptyCoherenceFile(), ['comic.caps-policy']).drafts).toEqual([]);
  });
});

describe('combined warnings on one balloon', () => {
  it('reports each lint that applies, with distinct keys and refs', () => {
    const state = comicState(onePage([panel('pn_a', [balloon('bl_a', `${words(26)} — Straße`)])]));
    state.manifest.project.language = 'de';
    const { input } = assembleInput(state, emptyCoherenceFile(), { detector: detect });
    expect(input.language).toBe('de');
    const out = run(state, emptyCoherenceFile(), [...COMIC_IDS]);
    expect(out.drafts.map((draft) => draft.checkId).sort()).toEqual([...COMIC_IDS].sort());
    expect(new Set(out.drafts.map((draft) => draft.factGroup)).size).toBe(out.drafts.length);
    for (const draft of out.drafts as readonly DraftFinding[]) {
      expect(draft.messageRef, draft.checkId).toBeDefined();
      const ref = draft.messageRef as { id: string; message: string; values?: Record<string, string | number> };
      const placeholders = [...ref.message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const name of placeholders) expect(Object.keys(ref.values ?? {}), `${ref.id} value ${name}`).toContain(name);
    }
  });
});

describe('the comic findings through the normal lifecycle (§6.1)', () => {
  const loud = () => comicState(onePage([panel('pn_a', [balloon('bl_a', words(26))])]));

  it('upserts stable findings keyed by the draft key, and the same ids across scans', () => {
    const state = loud();
    const first = full(state, emptyCoherenceFile());
    const comic = first.file.findings.filter((finding) => finding.checkId.startsWith('comic.'));
    expect(comic).toHaveLength(1);
    expect(comic[0]).toMatchObject({
      checkId: 'comic.balloon-density',
      type: 'balloon',
      severity: 'warning',
      status: 'open',
      factGroup: 'comic.balloon-density:balloon:n_p1:pn_a:bl_a',
      evidence: [],
      messageRef: { id: 'coherence.comic.densityBalloon' },
    });
    const second = full(state, first.file, LATER);
    expect(second.file.findings.map((finding) => finding.id)).toEqual(first.file.findings.map((finding) => finding.id));
    expect(second.file.findings[0]?.updatedAt).toBe(LATER.toISOString());
    expect(second.run.checkIds).toContain('comic.balloon-density');
  });

  it('keeps a dismissal across a re-scan, and re-open restores it to open', () => {
    const state = loud();
    const first = full(state, emptyCoherenceFile());
    const target = first.file.findings[0]?.id ?? '';
    const dismissed = dismissFinding(first.file, target, { reason: 'intentional', note: 'a shout' }, LATER);
    const second = full(state, dismissed, LATER);
    const finding = second.file.findings.find((candidate) => candidate.id === target);
    expect(finding?.status).toBe('dismissed');
    expect(finding?.redetections).toHaveLength(1);
    expect(second.run.notes?.join(' ')).toContain('1 previously dismissed finding(s) still present');
    const reopened = reopenFinding(second.file, target, LATER);
    expect(reopened.findings.find((candidate) => candidate.id === target)?.status).toBe('open');
    const third = full(state, reopened, LATER);
    expect(third.file.findings.find((candidate) => candidate.id === target)).toMatchObject({ status: 'open', runId: third.run.id });
  });

  it('keeps a fixed verdict and reports the recurrence without re-opening', () => {
    const state = loud();
    const first = full(state, emptyCoherenceFile());
    const target = first.file.findings[0]?.id ?? '';
    const fixed = markFindingFixed(first.file, target, 'split the balloon', LATER);
    const second = full(state, fixed, LATER);
    expect(second.file.findings.find((candidate) => candidate.id === target)?.status).toBe('fixed');
    expect(second.run.notes?.join(' ')).toContain('recurred after marked fixed');
  });

  it('clears an open comic finding when the balloon is shortened, and brings it back when it grows', () => {
    const state = loud();
    const first = full(state, emptyCoherenceFile());
    expect(first.file.findings).toHaveLength(1);
    const setBalloonText = (text: string): void => {
      const pageNode = state.manifest.tree.find((node) => node.id === 'n_p1');
      const stored = pageNode?.comicPage as { panels: { balloons: { text: string }[] }[] } | undefined;
      const firstBalloon = stored?.panels[0]?.balloons[0];
      if (firstBalloon === undefined) throw new Error('fixture: no balloon on the page');
      firstBalloon.text = text;
    };
    setBalloonText(words(25));
    const second = full(state, first.file, LATER);
    expect(second.file.findings).toEqual([]);
    expect(second.run.notes?.join(' ')).toContain('1 open finding(s) no longer detected were cleared');
    setBalloonText(words(40));
    const third = full(state, second.file, LATER);
    // The cleared finding was removed, so the re-detection is a new open finding with the same identity key.
    expect(third.file.findings).toHaveLength(1);
    expect(third.file.findings[0]).toMatchObject({
      status: 'open',
      checkId: 'comic.balloon-density',
      factGroup: first.file.findings[0]?.factGroup,
    });
    expect(third.file.findings[0]?.id).not.toBe(first.file.findings[0]?.id);
  });
});

describe('comic.balloon-coverage in the registry (comics.md §3.2)', () => {
  const SCRIPT_ID = 'n_script';
  const BODY = ['PAGE 1 (2 panels)', '', 'PANEL 1', '', '1. MARA: Who is there?', '', 'PANEL 2', '', '2. JONAH: Hold the line!', ''].join('\n');

  /** A coverage entry for one line of `BODY`, the shape `comic.derive` and `comic.scriptFromPages` write. */
  function cover(line: string, balloonId?: string, docId = SCRIPT_ID): unknown {
    const from = BODY.indexOf(line);
    return {
      kind: 'comic-script-line',
      docId,
      anchor: { from, to: from + line.length, exact: line, prefix: '', suffix: '', capturedRevision: 1 },
      ...(balloonId === undefined ? {} : { balloonId }),
    };
  }
  const covered = (id: string, balloons: readonly unknown[], script: readonly unknown[]) => ({ ...panel(id, balloons), script });

  /** A book linked to a comic-script document, in the research folder so the check cannot lean on the manuscript scan. */
  function scriptedState(panels: readonly unknown[], body = BODY, link: string | null = SCRIPT_ID): ProjectState {
    const state = comicState({ id: 'n_book', settings: link === null ? {} : { scriptDocId: link }, pages: [{ id: 'n_p1', panels }] });
    addDocument(state, { id: SCRIPT_ID, parentId: 'research', title: 'Script', type: 'document', kind: 'comic-script', body, now: NOW });
    return state;
  }
  const check = (state: ProjectState) => run(state, emptyCoherenceFile(), ['comic.balloon-coverage'] as never);

  const lettered = () => [
    covered('pn_a', [balloon('bl_a', 'Who is there?')], [cover('1. MARA: Who is there?', 'bl_a')]),
    covered('pn_b', [balloon('bl_b', 'Hold the line!')], [cover('2. JONAH: Hold the line!', 'bl_b')]),
  ];

  it('is registered after the lint, with a label and a spec-named place in the closed list', () => {
    expect(DETERMINISTIC_CHECK_IDS.at(-1)).toBe('comic.balloon-coverage');
    expect(Object.keys(DETERMINISTIC_CHECKS)).toContain('comic.balloon-coverage');
    expect(DETERMINISTIC_CHECK_LABELS['comic.balloon-coverage']).toBe('A script line has no balloon, or a balloon no longer matches its script line');
  });

  it('reads the linked script into the book fact, and nothing when the link is absent or broken', () => {
    const linked = assembleInput(scriptedState(lettered()), emptyCoherenceFile(), { detector: detect }).input.comics?.[0];
    expect(linked?.script).toMatchObject({ docId: SCRIPT_ID, body: BODY });
    expect(assembleInput(scriptedState(lettered(), BODY, null), emptyCoherenceFile(), { detector: detect }).input.comics?.[0]?.script).toBeUndefined();
    expect(assembleInput(scriptedState(lettered(), BODY, 'n_gone'), emptyCoherenceFile(), { detector: detect }).input.comics?.[0]?.script).toBeUndefined();
  });

  it('is silent when every line is lettered and every balloon still resolves', () => {
    const out = check(scriptedState(lettered()));
    expect(out.drafts).toEqual([]);
    expect(out.notes).toContain('comic coverage read 1 book(s) against their scripts, 1 page(s)');
  });

  it('reports a script line with no balloon (script to balloon)', () => {
    const out = check(scriptedState([covered('pn_a', [balloon('bl_a', 'Who is there?')], [cover('1. MARA: Who is there?', 'bl_a')]), panel('pn_b', [])]));
    expect(out.drafts).toHaveLength(1);
    const draft = out.drafts[0] as DraftFinding;
    expect(draft).toMatchObject({ checkId: 'comic.balloon-coverage', type: 'unletteredLine', severity: 'warning', evidence: [] });
    expect(draft.factGroup).toBe(`comic.balloon-coverage:${SCRIPT_ID}:1.2.0`.toLowerCase());
    expect(draft.message).toContain('The script line for JONAH on page 1, panel 2 has no balloon.');
    expect(draft.messageRef).toEqual({
      id: 'coherence.comic.coverageUnlettered',
      message: expect.stringContaining('{speaker}'),
      values: { speaker: 'JONAH', page: 1, panel: 2 },
    });
  });

  it('reports a balloon whose script text is gone, and one whose balloon left the panel (balloon to script)', () => {
    const stale = covered('pn_a', [balloon('bl_a', 'Who is there?')], [cover('1. MARA: Who goes there?', 'bl_a')]);
    const orphan = covered('pn_b', [], [cover('2. JONAH: Hold the line!', 'bl_missing')]);
    const out = check(scriptedState([stale, orphan]));
    const types = out.drafts.map((draft) => draft.type).sort();
    // The first panel's line is still lettered by hand (the balloon says the same), so only the second panel's is unlettered.
    expect(types).toEqual(['brokenBalloon', 'staleAnchor', 'unletteredLine']);
    const refs = new Map(out.drafts.map((draft) => [draft.type, draft.messageRef?.id]));
    expect(refs.get('staleAnchor')).toBe('coherence.comic.coverageStaleAnchor');
    expect(refs.get('brokenBalloon')).toBe('coherence.comic.coverageBrokenBalloon');
    expect(new Set(out.drafts.map((draft) => draft.factGroup)).size).toBe(out.drafts.length);
    for (const draft of out.drafts) {
      const ref = draft.messageRef as { message: string; values?: Record<string, string | number> };
      for (const name of [...ref.message.matchAll(/\{(\w+)\}/g)].map((match) => match[1])) {
        expect(Object.keys(ref.values ?? {}), `${draft.type} value ${name}`).toContain(name);
      }
    }
  });

  it('reports a line lettered from a script the book does not use', () => {
    const wrong = covered('pn_a', [balloon('bl_a', 'Who is there?')], [cover('1. MARA: Who is there?', 'bl_a', 'n_other')]);
    const out = check(scriptedState([wrong, panel('pn_b', [balloon('bl_b', 'Hold the line!')])]));
    expect(out.drafts.map((draft) => draft.type)).toContain('staleDocument');
    expect(out.drafts.find((draft) => draft.type === 'staleDocument')?.messageRef?.id).toBe('coherence.comic.coverageStaleDocument');
  });

  it('does not evaluate a book with no linked script, or a link whose document is gone, and says so', () => {
    const none = check(scriptedState(lettered(), BODY, null));
    expect(none.drafts).toEqual([]);
    expect(none.notes).toContain('comic coverage skipped 1 book(s) with no linked script');
    const broken = check(scriptedState(lettered(), BODY, 'n_gone'));
    expect(broken.drafts).toEqual([]);
    expect(broken.notes).toContain('comic coverage skipped 1 book(s) whose linked script is no longer in the project');
    expect(check(buildState({ scenes: [{ id: 'scene', title: 'Scene', body: 'A scene.' }] })).notes).toEqual([]);
  });

  it('runs on any scope and follows the normal lifecycle: upsert, dismissal, and clearing once the script is lettered', () => {
    const state = scriptedState([covered('pn_a', [balloon('bl_a', 'Who is there?')], [cover('1. MARA: Who is there?', 'bl_a')]), panel('pn_b', [])]);
    const first = full(state, emptyCoherenceFile());
    const open = first.file.findings.filter((finding) => finding.checkId === 'comic.balloon-coverage');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: 'unletteredLine', status: 'open', evidence: [], messageRef: { id: 'coherence.comic.coverageUnlettered' } });
    expect(first.run.checkIds).toContain('comic.balloon-coverage');

    const dismissed = dismissFinding(first.file, open[0]?.id ?? '', { reason: 'intentional', note: 'a silent beat' }, LATER);
    const again = full(state, dismissed, LATER);
    expect(again.file.findings.find((finding) => finding.id === open[0]?.id)?.status).toBe('dismissed');

    const page = state.manifest.tree.find((node) => node.id === 'n_p1');
    const stored = page?.comicPage as { panels: { balloons: unknown[] }[] } | undefined;
    stored?.panels[1]?.balloons.push(balloon('bl_b', 'Hold the line!'));
    const cleared = full(state, first.file, LATER);
    expect(cleared.file.findings.filter((finding) => finding.checkId === 'comic.balloon-coverage')).toEqual([]);
  });
});
