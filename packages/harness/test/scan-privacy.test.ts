
import { describe, expect, it } from 'vitest';

import { scanCompute, scanTool, type CoherenceFile, type ScopeSpec } from '@caotang/coherence';
import { loadInkCompiler } from '@caotang/dialogue';
import { withheldState } from '@caotang/context';
import { addDocument, addFolder, createEmptyManifest, createProjectState, nodeById, type CodexEntry, type ProjectState } from '@caotang/store';

import { computeScanWorker, countIn, projectScanInput } from '../src/index.js';
import { dialogueFactsOf } from '../src/coherence-facts.js';

const DOC = 'n_DOC0000001';
const SHOT = 'n_SHOT000001';
const COMIC = 'n_COMIC00001';
const PAGE = 'n_PAGE000001';
const SCRIPT = 'n_SCRIPT0001';
const ENTRY = 'c_ENTRY00001';

function trap(target: object, key: string, label: string): void {
  Object.defineProperty(target, key, { get: () => { throw new Error(`read denied content: ${label}`); }, enumerable: true, configurable: true });
}

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('Scan Privacy'));
  addDocument(state, { parentId: 'manuscript', title: 'The Scene', body: 'SECRET-DOC-BODY', id: DOC });
  addFolder(state, { parentId: 'manuscript', title: 'A Shot', id: SHOT });
  const shot = nodeById(state, SHOT);
  if (shot !== undefined) { shot.type = 'shot'; shot.shot = { durationSec: 2, dialogue: [] }; }
  addFolder(state, { parentId: 'manuscript', title: 'A Book', id: COMIC });
  const comic = nodeById(state, COMIC);
  if (comic !== undefined) { comic.kind = 'comic'; comic.comic = { scriptDocId: SCRIPT }; }
  addFolder(state, { parentId: COMIC, title: 'Page 1', id: PAGE });
  const page = nodeById(state, PAGE);
  if (page !== undefined) { page.type = 'comic-page'; page.comicPage = { panels: [] }; }
  addDocument(state, { parentId: 'manuscript', title: 'The Script', body: 'SECRET-SCRIPT-BODY', id: SCRIPT });
  const script = nodeById(state, SCRIPT);
  if (script !== undefined) script.kind = 'comic-script';
  const entry: CodexEntry = { id: ENTRY, name: 'Mara', aliases: [], type: 'character', description: 'SECRET-DESCRIPTION', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [DOC], keywords: [], origin: 'manual', sources: [{ quote: 'SECRET-PROVENANCE' }] as CodexEntry['sources'] };
  state.manifest.codex = [entry];
  return state;
}

const emptyFile = (): CoherenceFile => ({ formatVersion: 1, findings: [], runs: [], sceneMeta: {}, worldRules: [], knowledge: [], reviewState: {} });

describe('the worker scan projection filters denied fact sources before reading them', () => {
  it('does not read a dialogue body for a changed or document-only scan', () => {
    const state = makeState();
    addDocument(state, { id: 'n_DIALOGUE01', parentId: 'manuscript', title: 'A branch', type: 'dialogue', body: 'IRRELEVANT-INK' });
    trap(state.documents.get('n_DIALOGUE01')!, 'body', 'unrequested dialogue body');
    for (const scope of [{ mode: 'changed' as const }, { mode: 'doc' as const, docIds: [DOC] }]) {
      const projected = projectScanInput(state, emptyFile(), undefined, scope);
      expect(projected.state.documents.has('n_DIALOGUE01')).toBe(false);
    }
  });

  it('never reads a denied document body, shot metadata, comic pages, linked script or attached-only codex description', () => {
    const state = makeState();
    trap(state.documents.get(DOC) as object, 'body', 'denied document body');
    trap(state.documents.get(SCRIPT) as object, 'body', 'denied linked script body');
    trap(nodeById(state, SHOT) as object, 'shot', 'denied shot metadata');
    trap(nodeById(state, COMIC) as object, 'comic', 'denied comic settings');
    trap(nodeById(state, PAGE) as object, 'comicPage', 'denied comic page');
    trap((state.manifest.codex as CodexEntry[])[0] as object, 'description', 'denied codex description');
    trap((state.manifest.codex as CodexEntry[])[0] as object, 'sources', 'codex provenance');
    const withheld = new Set([DOC, SHOT, COMIC, PAGE, SCRIPT]);
    expect(() => projectScanInput(state, emptyFile(), withheld)).not.toThrow();
  });

  it('leaves denied nodes, their bodies and attached-only codex out of the clone', () => {
    const state = makeState();
    const withheld = new Set([DOC, SHOT, COMIC, PAGE, SCRIPT]);
    const projected = projectScanInput(state, emptyFile(), withheld);
    const ids = projected.state.manifest.tree.map((node) => node.id);
    for (const denied of withheld) expect(ids).not.toContain(denied);
    expect(projected.state.documents.has(DOC)).toBe(false);
    expect(projected.state.documents.has(SCRIPT)).toBe(false);
    expect(projected.state.manifest.codex).toHaveLength(0);
    const json = JSON.stringify(projected);
    expect(json).not.toContain('SECRET-DOC-BODY');
    expect(json).not.toContain('SECRET-SCRIPT-BODY');
    expect(json).not.toContain('SECRET-DESCRIPTION');
    expect(json).not.toContain('SECRET-PROVENANCE');
    expect(() => structuredClone(projected)).not.toThrow();
  });

  it('keeps a visible codex entry and a visible document, and carries no description the checks do not read', () => {
    const state = makeState();
    const projected = projectScanInput(state, emptyFile(), undefined);
    expect(projected.state.manifest.tree.map((node) => node.id)).toContain(DOC);
    expect(projected.state.documents.get(DOC)?.body).toBe('SECRET-DOC-BODY');
    expect(projected.state.manifest.codex).toHaveLength(1);
    expect(projected.state.manifest.codex?.[0]?.description).toBe('');
  });

  it('carries only the held file’s check inputs, never its old findings or runs', () => {
    const state = makeState();
    const file = emptyFile();
    file.findings.push({ id: 'f_old', checkId: 'pov.coverage', type: 'pov', severity: 'info', factGroup: 'g', status: 'open', origin: 'found', evidence: [{ docId: DOC, quote: 'OLD-QUOTE', from: 0, to: 8 }], message: 'OLD-FINDING', firstSeenRunId: 'r0', lastSeenRunId: 'r0', dismissed: false } as never);
    file.sceneMeta[DOC] = { pov: ENTRY };
    const projected = projectScanInput(state, file, undefined);
    expect(projected.file.sceneMeta[DOC]).toEqual({ pov: ENTRY });
    const json = JSON.stringify(projected);
    expect(json).not.toContain('OLD-FINDING');
    expect(json).not.toContain('OLD-QUOTE');
  });
});

describe('the synchronous scan reads the filtered view, so denied facts raise no findings', () => {
  it('a codex entry attached only to a withheld document is not scanned', () => {
    const state = makeState();
    const withheld = new Set([DOC]);
    const view = withheldState(state, withheld);
    expect(view.manifest.codex).toHaveLength(0);
    const outcome = scanTool({ scope: { mode: 'full' } }, { state: view, file: emptyFile(), now: new Date(0), detector: countIn, approvedLargeScope: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.documents).toBeGreaterThan(0);
      expect(outcome.file).toBeDefined();
      const json = JSON.stringify(outcome.file?.findings);
      expect(json).not.toContain('SECRET-DOC-BODY');
      expect(json).not.toContain(ENTRY);
    }
  });

  it('a denied shot and comic raise no shot or comic findings', () => {
    const state = makeState();
    const withheld = new Set([SHOT, COMIC, PAGE, SCRIPT]);
    const view = withheldState(state, withheld);
    const outcome = scanTool({ scope: { mode: 'full' } }, { state: view, file: emptyFile(), now: new Date(0), detector: countIn, approvedLargeScope: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.file).toBeDefined();
      const comicOrShot = (outcome.file?.findings ?? []).filter((finding) => finding.checkId.startsWith('comic.') || finding.checkId === 'script.shot-coverage');
      expect(comicOrShot).toHaveLength(0);
    }
  });
});

describe('the worker scan computes what the synchronous scan computes', () => {
  async function workerCompute(state: ProjectState, file: CoherenceFile, withheld: ReadonlySet<string> | undefined, scope: ScopeSpec) {
    const projected = projectScanInput(state, file, withheld, scope);
    return computeScanWorker({ ...projected, params: { scope }, approvedLargeScope: true });
  }
  function syncCompute(state: ProjectState, file: CoherenceFile, scope: ScopeSpec, withheld?: ReadonlySet<string>) {
    const view = withheld === undefined ? state : withheldState(state, withheld);
    const dialogue = scope.mode === 'full' ? dialogueFactsOf(view) : undefined;
    const excludedDocIds = withheld === undefined ? undefined : projectScanInput(state, file, withheld, scope).excludedDocIds;
    return scanCompute({ scope }, {
      state: view,
      file,
      detector: countIn,
      approvedLargeScope: true,
      ...(dialogue === undefined ? {} : { dialogue }),
      ...(withheld === undefined ? {} : { isExcluded: (node) => withheld.has(node.id) }),
      ...(excludedDocIds === undefined ? {} : { excludedDocIds }),
    });
  }

  it('a full scan over documents, shots, comics and a linked script matches', async () => {
    const state = makeState();
    const file = emptyFile();
    file.sceneMeta[DOC] = { pov: ENTRY, dayOffset: 2 };
    expect(await workerCompute(state, file, undefined, { mode: 'full' })).toEqual(syncCompute(state, file, { mode: 'full' }));
  });

  it.each([null, 'invalid', 42])('preserves tolerant media defaults for malformed root metadata: %j', async (raw) => {
    const state = makeState();
    const shot = nodeById(state, SHOT)!;
    const comic = nodeById(state, COMIC)!;
    const page = nodeById(state, PAGE)!;
    shot.shot = raw as never;
    comic.comic = raw as never;
    page.comicPage = raw as never;
    const file = emptyFile();
    expect(await workerCompute(state, file, undefined, { mode: 'full' })).toEqual(syncCompute(state, file, { mode: 'full' }));
  });

  it('a changed scan matches, using the review state it carries', async () => {
    const state = makeState();
    const file = emptyFile();
    file.reviewState[DOC] = { lastReviewedRevision: 0, lastReviewedAt: '2026-01-01T00:00:00.000Z' };
    expect(await workerCompute(state, file, undefined, { mode: 'changed' })).toEqual(syncCompute(state, file, { mode: 'changed' }));
  });

  it('a doc scan matches', async () => {
    const state = makeState();
    const file = emptyFile();
    expect(await workerCompute(state, file, undefined, { mode: 'doc', docIds: [DOC] })).toEqual(syncCompute(state, file, { mode: 'doc', docIds: [DOC] }));
  });

  it('a knowledge scan matches', async () => {
    const state = makeState();
    const file = emptyFile();
    file.knowledge.push({ id: 'k_FACT000001', text: 'The light is kept.', entryId: ENTRY, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    file.sceneMeta[DOC] = { learns: [{ entryId: ENTRY, factId: 'k_FACT000001' }] } as never;
    expect(await workerCompute(state, file, undefined, { mode: 'full' })).toEqual(syncCompute(state, file, { mode: 'full' }));
  });

  it('a full scan with a dialogue container matches, carrying the container body', async () => {
    await loadInkCompiler();
    const state = makeState();
    const ink = '-> tavern\n=== tavern ===\nInnkeeper: Ah, a traveller.\n* [Order an ale] -> END\n';
    addDocument(state, { id: 'n_TAVERN0001', parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: ink });
    const file = emptyFile();
    const projected = projectScanInput(state, file, undefined, { mode: 'full' });
    expect(projected.state.documents.get('n_TAVERN0001')?.body).toBe(ink);
    const outcome = await workerCompute(state, file, undefined, { mode: 'full' });
    expect(outcome).toEqual(syncCompute(state, file, { mode: 'full' }));
    expect(outcome.ok && outcome.compute.drafts.some((draft) => draft.checkId === 'dialogue.speaker-unknown')).toBe(true);
  });

  it('a withheld document’s scan matches the filtered synchronous scan', async () => {
    const state = makeState();
    const file = emptyFile();
    const withheld = new Set([DOC]);
    const projected = await workerCompute(state, file, withheld, { mode: 'full' });
    expect(projected).toEqual(syncCompute(state, file, { mode: 'full' }, withheld));
  });
});

describe('the worker scan projection carries only what the checks read', () => {
  it('leaves unrelated research and archived document bodies behind', () => {
    const state = makeState();
    addDocument(state, { parentId: 'research', title: 'Research', body: 'RESEARCH-BODY', id: 'n_RESEARCH01' });
    addDocument(state, { parentId: 'manuscript', title: 'Archived', body: 'ARCHIVED-BODY', id: 'n_ARCHIVED01' });
    const archived = nodeById(state, 'n_ARCHIVED01');
    if (archived !== undefined) archived.status = 'archived';
    const projected = projectScanInput(state, emptyFile(), undefined, { mode: 'full' });
    expect(projected.state.documents.has(DOC)).toBe(true);
    expect(projected.state.documents.has(SCRIPT)).toBe(true);
    expect(projected.state.documents.has('n_RESEARCH01')).toBe(false);
    expect(projected.state.documents.has('n_ARCHIVED01')).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('RESEARCH-BODY');
    expect(JSON.stringify(projected)).not.toContain('ARCHIVED-BODY');
  });

  it('a doc scope names a research document the scan may read', () => {
    const state = makeState();
    addDocument(state, { parentId: 'research', title: 'Research', body: 'RESEARCH-BODY', id: 'n_RESEARCH01' });
    const projected = projectScanInput(state, emptyFile(), undefined, { mode: 'doc', docIds: ['n_RESEARCH01'] });
    expect(projected.state.documents.has('n_RESEARCH01')).toBe(true);
  });

  it('drops shot text and fields the checks do not read, keeping duration and coverage', () => {
    const state = makeState();
    const shot = nodeById(state, SHOT);
    if (shot !== undefined) shot.shot = { durationSec: 2, dialogue: [], action: 'SECRET-ACTION', image: 'asset-1', imageAlt: 'SECRET-ALT', lens: 'SECRET-LENS' } as never;
    const projected = projectScanInput(state, emptyFile(), undefined);
    const projectedShot = projected.state.manifest.tree.find((node) => node.id === SHOT)?.shot as Record<string, unknown>;
    expect(projectedShot['durationSec']).toBe(2);
    expect(projectedShot['dialogue']).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain('SECRET-ACTION');
    expect(JSON.stringify(projected)).not.toContain('SECRET-ALT');
    expect(JSON.stringify(projected)).not.toContain('SECRET-LENS');
  });

  it('drops denied sceneMeta and reviewState rows and extra future fields', () => {
    const state = makeState();
    const file = emptyFile();
    file.sceneMeta[DOC] = { pov: ENTRY, futureField: 'SECRET-META' } as never;
    file.sceneMeta['n_DENIED0001'] = { pov: ENTRY };
    file.reviewState[DOC] = { lastReviewedRevision: 1, lastReviewedAt: '2026-01-01T00:00:00.000Z', futureField: 'SECRET-REVIEW' } as never;
    file.reviewState['n_DENIED0001'] = { lastReviewedRevision: 1, lastReviewedAt: '2026-01-01T00:00:00.000Z' };
    const projected = projectScanInput(state, file, new Set(['n_DENIED0001']));
    expect(projected.file.sceneMeta[DOC]).toEqual({ pov: ENTRY });
    expect(projected.file.sceneMeta['n_DENIED0001']).toBeUndefined();
    expect(projected.file.reviewState[DOC]).toEqual({ lastReviewedRevision: 1, lastReviewedAt: '2026-01-01T00:00:00.000Z' });
    expect(projected.file.reviewState['n_DENIED0001']).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('SECRET-META');
    expect(JSON.stringify(projected)).not.toContain('SECRET-REVIEW');
  });

  it('carries knowledge facts field by field, without extra future fields', () => {
    const state = makeState();
    const file = emptyFile();
    file.knowledge.push({ id: 'k_FACT000001', text: 'A fact.', entryId: ENTRY, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', futureField: 'SECRET-KNOWLEDGE' } as never);
    const projected = projectScanInput(state, file, undefined);
    expect(projected.file.knowledge[0]).toEqual({ id: 'k_FACT000001', text: 'A fact.', entryId: ENTRY, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(JSON.stringify(projected)).not.toContain('SECRET-KNOWLEDGE');
  });
});

describe('media coverage and comic lint: allowed parity and denied sources', () => {
  const SCREEN = 'n_SCREEN0001';
  const CUE_BODY = 'INT. HALL - DAY\n\nBOB\nWhere were you?\n';
  const anchor = (exact: string) => ({ from: 0, to: exact.length, exact, prefix: '', suffix: '', capturedRevision: 1 });

  async function workerOn(state: ProjectState, file: CoherenceFile, withheld: ReadonlySet<string> | undefined) {
    const projected = projectScanInput(state, file, withheld, { mode: 'full' });
    return computeScanWorker({ ...projected, params: { scope: { mode: 'full' } }, approvedLargeScope: true });
  }
  function syncOnProjected(state: ProjectState, file: CoherenceFile, withheld: ReadonlySet<string> | undefined) {
    const projected = projectScanInput(state, file, withheld, { mode: 'full' });
    return scanCompute({ scope: { mode: 'full' } }, { state: projected.state, file: projected.file, detector: countIn, approvedLargeScope: true, dialogue: dialogueFactsOf(projected.state), ...(projected.excludedDocIds === undefined ? {} : { excludedDocIds: projected.excludedDocIds }) });
  }
  function addScreenplay(state: ProjectState, id: string, body: string): void {
    addDocument(state, { parentId: 'manuscript', title: 'Screenplay', body, id });
    const node = nodeById(state, id);
    if (node !== undefined) node.kind = 'screenplay';
  }

  it('an allowed shot-coverage anchor-drift finding matches between worker and sync', async () => {
    const state = makeState();
    addScreenplay(state, SCREEN, CUE_BODY);
    const shot = nodeById(state, SHOT);
    if (shot !== undefined) shot.shot = { durationSec: 2, dialogue: [{ kind: 'fountain-element', docId: SCREEN, anchor: anchor('WRONG') }] } as never;
    const file = emptyFile();
    const worker = await workerOn(state, file, undefined);
    expect(worker).toEqual(syncOnProjected(state, file, undefined));
    expect(worker.ok && worker.compute.drafts.some((draft) => draft.checkId === 'script.shot-coverage')).toBe(true);
  });

  it('an allowed comic balloon-density finding matches between worker and sync', async () => {
    const state = makeState();
    const page = nodeById(state, PAGE);
    if (page !== undefined) page.comicPage = { size: 'us-comic', panels: [{ id: 'p1', rect: [0, 0, 1, 0.5], balloons: [{ id: 'b1', kind: 'speech', text: Array.from({ length: 26 }, () => 'word').join(' '), rect: [0.1, 0.1, 0.3, 0.15] }] }] } as never;
    const file = emptyFile();
    const worker = await workerOn(state, file, undefined);
    expect(worker).toEqual(syncOnProjected(state, file, undefined));
    expect(worker.ok && worker.compute.drafts.some((draft) => draft.checkId === 'comic.balloon-density')).toBe(true);
  });

  it('a visible shot whose coverage names a denied source drops the anchor before reading it', async () => {
    const state = makeState();
    addScreenplay(state, SCREEN, CUE_BODY);
    const deniedAnchor = { from: 0, to: 5, exact: 'DENIED-SOURCE-EXACT', prefix: 'DENIED-SOURCE-PREFIX', suffix: 'DENIED-SOURCE-SUFFIX', capturedRevision: 1 };
    trap(deniedAnchor, 'exact', 'denied source exact');
    trap(deniedAnchor, 'prefix', 'denied source prefix');
    trap(deniedAnchor, 'suffix', 'denied source suffix');
    const shot = nodeById(state, SHOT);
    if (shot !== undefined) shot.shot = { durationSec: 2, dialogue: [{ kind: 'fountain-element', docId: SCREEN, anchor: deniedAnchor }] } as never;
    const withheld = new Set([SCREEN]);
    const file = emptyFile();
    expect(() => projectScanInput(state, file, withheld, { mode: 'full' })).not.toThrow();
    const projected = projectScanInput(state, file, withheld, { mode: 'full' });
    expect(JSON.stringify(projected)).not.toContain('DENIED-SOURCE-EXACT');
    expect(await workerOn(state, file, withheld)).toEqual(syncOnProjected(state, file, withheld));
  });

  it('a visible panel whose script coverage names a denied script drops the anchor before reading it', async () => {
    const state = makeState();
    const deniedAnchor = { from: 0, to: 5, exact: 'DENIED-SCRIPT-EXACT', prefix: 'DENIED-SCRIPT-PREFIX', suffix: 'DENIED-SCRIPT-SUFFIX', capturedRevision: 1 };
    trap(deniedAnchor, 'exact', 'denied script exact');
    trap(deniedAnchor, 'prefix', 'denied script prefix');
    trap(deniedAnchor, 'suffix', 'denied script suffix');
    const page = nodeById(state, PAGE);
    if (page !== undefined) page.comicPage = { size: 'us-comic', panels: [{ id: 'p1', balloons: [], script: [{ kind: 'comic-script-line', docId: SCRIPT, anchor: deniedAnchor, balloonId: 'b1' }] }] } as never;
    const withheld = new Set([SCRIPT]);
    const file = emptyFile();
    expect(() => projectScanInput(state, file, withheld, { mode: 'full' })).not.toThrow();
    const projected = projectScanInput(state, file, withheld, { mode: 'full' });
    expect(JSON.stringify(projected)).not.toContain('DENIED-SCRIPT-EXACT');
    expect(await workerOn(state, file, withheld)).toEqual(syncOnProjected(state, file, withheld));
  });

  it('drops panel image/crop/border, balloon style and coverage/anchor future fields, keeping allowed coverage', async () => {
    const state = makeState();
    const page = nodeById(state, PAGE);
    if (page !== undefined) page.comicPage = {
      size: 'us-comic',
      panels: [{
        id: 'p1', rect: [0, 0, 1, 0.5], assetId: 'SECRET-ASSET', crop: [0, 0, 1, 1], border: { style: 'SECRET-BORDER' }, futurePanelField: 'SECRET-PANEL-FUTURE',
        balloons: [{ id: 'b1', kind: 'speech', text: 'hi', speaker: 'SECRET-SPEAKER', rect: [0, 0, 1, 1], tail: [0, 0], fontSize: 12, style: { weight: 'SECRET-STYLE' }, futureBalloonField: 'SECRET-BALLOON-FUTURE' }],
        script: [{ kind: 'comic-script-line', docId: SCRIPT, anchor: { ...anchor('hi'), futureAnchorField: 'SECRET-ANCHOR-FUTURE' }, balloonId: 'b1', futureCoverageField: 'SECRET-COVERAGE-FUTURE' }],
      }],
    } as never;
    const shot = nodeById(state, SHOT);
    if (shot !== undefined) shot.shot = { durationSec: 2, image: 'SECRET-IMAGE', action: 'SECRET-ACTION', dialogue: [{ kind: 'fountain-element', docId: DOC, anchor: { ...anchor('hi'), futureAnchorField: 'SECRET-SHOT-ANCHOR-FUTURE' }, futureCoverageField: 'SECRET-SHOT-COVERAGE-FUTURE' }] } as never;
    const file = emptyFile();
    const projected = projectScanInput(state, file, undefined, { mode: 'full' });
    const json = JSON.stringify(projected);
    for (const secret of ['SECRET-ASSET', 'SECRET-BORDER', 'SECRET-PANEL-FUTURE', 'SECRET-SPEAKER', 'SECRET-STYLE', 'SECRET-BALLOON-FUTURE', 'SECRET-ANCHOR-FUTURE', 'SECRET-COVERAGE-FUTURE', 'SECRET-IMAGE', 'SECRET-ACTION', 'SECRET-SHOT-ANCHOR-FUTURE', 'SECRET-SHOT-COVERAGE-FUTURE']) {
      expect(json).not.toContain(secret);
    }
    expect(await workerOn(state, file, undefined)).toEqual(syncOnProjected(state, file, undefined));
  });

  it('a denied manuscript document is disclosed in compute.excludedDocIds without reading its body', async () => {
    const state = makeState();
    const record = state.documents.get(DOC);
    if (record !== undefined) trap(record, 'body', 'denied document body');
    const withheld = new Set([DOC]);
    const file = emptyFile();
    const projected = projectScanInput(state, file, withheld, { mode: 'full' });
    expect(projected.excludedDocIds).toEqual([DOC]);
    const worker = await computeScanWorker({ ...projected, params: { scope: { mode: 'full' } }, approvedLargeScope: true });
    expect(worker.ok && worker.compute.excludedDocIds).toContain(DOC);
  });

  it('a denied named doc-scope target is disclosed in excludedDocIds', () => {
    const state = makeState();
    addDocument(state, { parentId: 'research', title: 'Research', body: 'RESEARCH-BODY', id: 'n_RES0000001' });
    const withheld = new Set(['n_RES0000001']);
    const projected = projectScanInput(state, emptyFile(), withheld, { mode: 'doc', docIds: ['n_RES0000001'] });
    expect(projected.excludedDocIds).toContain('n_RES0000001');
  });

  it('sceneMeta threads carry only id/payoff and learns/knows only entryId/factId, never reading thread.note', () => {
    const state = makeState();
    const file = emptyFile();
    const thread = { id: 'thread-1', payoff: DOC, note: 'SECRET-THREAD-NOTE' };
    trap(thread, 'note', 'thread note');
    file.sceneMeta[DOC] = { threads: [thread], learns: [{ entryId: ENTRY, factId: 'k_FACT000001', futureField: 'SECRET-LEARN' }], knows: [{ entryId: ENTRY, factId: 'k_FACT000002', futureField: 'SECRET-KNOW' }] } as never;
    expect(() => projectScanInput(state, file, undefined, { mode: 'full' })).not.toThrow();
    const projected = projectScanInput(state, file, undefined, { mode: 'full' });
    expect(projected.file.sceneMeta[DOC]).toEqual({ threads: [{ id: 'thread-1', payoff: DOC }], learns: [{ entryId: ENTRY, factId: 'k_FACT000001' }], knows: [{ entryId: ENTRY, factId: 'k_FACT000002' }] });
    const json = JSON.stringify(projected);
    expect(json).not.toContain('SECRET-THREAD-NOTE');
    expect(json).not.toContain('SECRET-LEARN');
    expect(json).not.toContain('SECRET-KNOW');
  });
});
