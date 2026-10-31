/**
 * `codex.importBatch`'s apply (codex.md §7.1): the writer's import of codex entries and their Research pages, one command and
 * one undo group.
 *
 * What is pinned: entries are stamped `origin: 'import'`, attached to the page or document they cite, with the citation as
 * the body holds it; the pages land in research; one Undo returns the project to the bytes it had (manifest and documents);
 * 600 entries with 600 pages import and undo well inside two seconds; an agent's call is refused by the gate before anything
 * runs; and the bus's enums agree with the store's through the validator.
 */

import { describe, expect, it } from 'vitest';

import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandParams,
  type ExecutionOutcome,
} from '@caotang/bus';

import {
  CODEX_INCLUDE_POLICIES,
  CODEX_TYPES,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  nodeById,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-31T10:00:00+01:00');
const CHAPTER = 'n_CHAPTER0001';
const LANDING = 'n_LANDING0001';
const LANDING_BODY = 'The ferry was late. Elena counted the gulls.';
const clock = { now: () => 1_761_900_000_000 };

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: LANDING_BODY, now: OPENED, id: LANDING });
  return state;
}

function harness(state: ProjectState = makeState()) {
  const registry = createProjectCommandRegistry({ clock });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  let seq = 0;
  const command = (params: CommandParams['codex.importBatch'], issuedBy: 'user' | 'agent' = 'user'): Command => ({
    id: `cmd_IMPORT${String((seq += 1)).padStart(4, '0')}`,
    name: 'codex.importBatch',
    params: params as unknown as Record<string, unknown>,
    issuedBy,
    ...(issuedBy === 'agent' ? { turnId: 'turn-1', callId: 'call-1' } : {}),
    createdAt: clock.now(),
  });
  return { state, bus, registry, undo, command, exec: (c: Command) => execute(c, bus, registry) };
}

/** The project as bytes: the manifest and every document body and revision. */
function bytesOf(state: ProjectState): string {
  const documents = [...state.documents.values()].map((doc) => [doc.id, doc.revision, doc.body]).sort();
  return JSON.stringify({ manifest: state.manifest, documents });
}

function quoteAt(body: string, term: string): { from: number; to: number; quote: string } {
  const from = body.indexOf(term);
  return { from, to: from + term.length, quote: term };
}

describe('codex.importBatch — the apply', () => {
  it('creates the pages in research and each entry attached to what it cites, stamped import', () => {
    const h = harness();
    const page = { title: 'Mara (wiki)', body: 'Mara keeps the light on the north point.' };
    const result = h.exec(
      h.command({
        entries: [
          { name: 'Mara', aliases: ['the keeper'], type: 'character', description: 'Keeps the light.', keywords: ['kanka:character'], page: 0, cite: quoteAt(page.body, 'Mara') },
          { name: 'Elena', type: 'character', includePolicy: 'manual', attachTo: LANDING, cite: quoteAt(LANDING_BODY, 'Elena') },
        ],
        pages: [page],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.result as { created: string[]; pages: string[] };
    expect(value.created).toHaveLength(2);
    expect(value.pages).toHaveLength(1);
    const pageNode = nodeById(h.state, value.pages[0]!);
    expect(pageNode?.parentId).toBe('research');
    expect(pageNode?.title).toBe('Mara (wiki)');
    expect(h.state.documents.get(pageNode!.id)?.body).toBe(page.body);

    const [mara, elena] = h.state.manifest.codex ?? [];
    expect(mara).toMatchObject({ name: 'Mara', aliases: ['the keeper'], origin: 'import', attachments: [pageNode!.id], keywords: ['kanka:character'], includePolicy: 'detected' });
    expect(mara?.sources[0]).toMatchObject({ docId: pageNode!.id, from: 0, to: 4, quote: 'Mara' });
    expect(elena).toMatchObject({ name: 'Elena', origin: 'import', attachments: [LANDING], includePolicy: 'manual' });
    expect(LANDING_BODY.slice(elena!.sources[0]!.from, elena!.sources[0]!.to)).toBe('Elena');
    expect(result.value.undoGroupId).toBeDefined();
  });

  it('is one undo group: one Undo returns the project to the bytes it had', () => {
    const h = harness();
    const before = bytesOf(h.state);
    const pages = [{ title: 'Mara', body: 'Mara keeps the light.' }, { title: 'Tomas', body: 'Tomas rows the ferry.' }];
    const result = h.exec(
      h.command({
        entries: [
          { name: 'Mara', page: 0, cite: quoteAt(pages[0]!.body, 'Mara') },
          { name: 'Tomas', page: 1, cite: quoteAt(pages[1]!.body, 'Tomas') },
        ],
        pages,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.undo.groups()).toHaveLength(1);
    const undone = h.undo.undo(result.value.undoGroupId!);
    expect(undone.ok && undone.value.failures).toEqual([]);
    expect(bytesOf(h.state)).toBe(before);
  });

  it('imports 600 entries with 600 pages as one undo group in under two seconds, and one Undo removes them all', () => {
    const h = harness();
    const before = bytesOf(h.state);
    const pages = Array.from({ length: 600 }, (_, i) => ({ title: `Person ${i}`, body: `Person${i} lives by the harbour.\n\nMore about Person${i}.` }));
    const entries = pages.map((page, i) => ({
      name: `Person${i}`,
      aliases: [`P-${i}`],
      type: 'character',
      description: `Person number ${i}.`,
      page: i,
      cite: quoteAt(page.body, `Person${i}`),
    }));
    const started = performance.now();
    const result = h.exec(h.command({ entries, pages }));
    const imported = performance.now() - started;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.state.manifest.codex).toHaveLength(600);
    expect(h.undo.groups()).toHaveLength(1);
    expect(imported).toBeLessThan(2000);
    const undoStarted = performance.now();
    const undone = h.undo.undo(result.value.undoGroupId!);
    expect(performance.now() - undoStarted).toBeLessThan(2000);
    expect(undone.ok && undone.value.failures).toEqual([]);
    expect(h.state.manifest.codex).toHaveLength(0);
    expect(bytesOf(h.state)).toBe(before);
  });

  it('writes nothing when one entry is refused: the whole batch is validated first', () => {
    const h = harness();
    const before = bytesOf(h.state);
    const page = { title: 'Mara', body: 'Mara keeps the light.' };
    const result = h.exec(
      h.command({
        entries: [
          { name: 'Mara', page: 0, cite: quoteAt(page.body, 'Mara') },
          { name: 'mara', page: 0, cite: quoteAt(page.body, 'Mara') },
        ],
        pages: [page],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/"mara".*collides with "Mara" in this same import/);
    expect(bytesOf(h.state)).toBe(before);
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('refuses an agent’s call at the gate: the agent imports through codex.import, capped at 20', () => {
    const h = harness();
    const before = bytesOf(h.state);
    const page = { title: 'Mara', body: 'Mara keeps the light.' };
    const result = h.exec(h.command({ entries: [{ name: 'Mara', page: 0, cite: quoteAt(page.body, 'Mara') }], pages: [page] }, 'agent'));
    expect(result.ok).toBe(false);
    expect(bytesOf(h.state)).toBe(before);
  });

  it('agrees with the store on the codex enums: every store type and policy validates, and nothing else does', () => {
    const h = harness();
    const descriptor = h.registry['codex.importBatch'].descriptor;
    const page = { title: 'Mara', body: 'Mara keeps the light.' };
    const params = (extra: Record<string, unknown>) => ({ entries: [{ name: 'Mara', page: 0, cite: quoteAt(page.body, 'Mara'), ...extra }], pages: [page] });
    for (const type of CODEX_TYPES) expect(descriptor.validate(params({ type }), h.state).ok, type).toBe(true);
    for (const includePolicy of CODEX_INCLUDE_POLICIES) expect(descriptor.validate(params({ includePolicy }), h.state).ok, includePolicy).toBe(true);
    expect(descriptor.validate(params({ type: 'faction' }), h.state).ok).toBe(false);
    expect(descriptor.validate(params({ includePolicy: 'sometimes' }), h.state).ok).toBe(false);
  });

  it('reports the pages and documents it attached to, by title', () => {
    const h = harness();
    const page = { title: 'Mara', body: 'Mara keeps the light.' };
    const result = h.exec(h.command({ entries: [{ name: 'Mara', page: 0, cite: quoteAt(page.body, 'Mara') }, { name: 'Elena', attachTo: LANDING, cite: quoteAt(LANDING_BODY, 'Elena') }], pages: [page] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome: ExecutionOutcome = result.value;
    expect(outcome.affected.map((a) => a.title).sort()).toEqual(['Mara', 'The Landing']);
  });
});
