/**
 * The old/new body-write boundary (pictures.md §2.3): `doc.write`, `editor.insert` and
 * `editor.replaceRange` all route through it, so every body write maps the document's paragraph links
 * across the write through the `AnchorPort`, captures the prior links for undo, and one undo restores
 * body and links together while the revision keeps increasing.
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
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { captureParagraphAnchor, paragraphAnchorPort, type AnchorPort, type ParagraphAnchor } from '@caotang/pictures';
import {
  addDocument,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  getRevision,
  reconcileAdoptedBody,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T10:00:00.000Z') };
const LANDING = 'n_7K2QX9M4A1';
const ONE = 'a_7K2QX9M4A1';
const P1 = 'The ferry left the harbour at dawn, and nobody waved.';
const P2 = 'Elena counted the gulls twice, because she did not trust the first count.';
const P3 = 'The lamp in the watchroom was lit all night, though no ship came.';
const BODY = `${P1}\n\n${P2}\n\n${P3}\n`;

function record(id: string) {
  return { id, file: `${id}.png`, mime: 'image/png' as const, sha256: id.slice(2).toLowerCase().padEnd(64, '0'), bytes: 100, createdAt: NOW.toISOString() };
}

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Anchored', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: BODY, now: NOW, id: LANDING });
  state.manifest.assets = [record(ONE)];
  const anchor = captureParagraphAnchor(BODY, BODY.indexOf('Elena'), 0);
  if (anchor === undefined) throw new Error('no anchor');
  state.manifest.assetLinks = [{ id: 'l_1AAAAAAAAA', assetId: ONE, target: { kind: 'paragraph', nodeId: LANDING, anchor }, role: 'reference', order: 10, note: 'The count' }];
  return state;
}

interface Host {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
}

function host(state: ProjectState = project(), options: { anchors?: AnchorPort } = {}): Host {
  const registry = createProjectCommandRegistry({ clock, ...options });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  return { state, undo, bus, registry };
}

let ordinal = 0;
function run(h: Host, name: CommandName, params: Record<string, unknown>): Result<ExecutionOutcome, CommandError> {
  ordinal += 1;
  const command: Command = { id: `cmd_BODYWRITE${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
  return execute(command, h.bus, h.registry);
}

function value(result: Result<ExecutionOutcome, CommandError>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function undoLast(h: Host): void {
  const last = h.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = h.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

type ParaTarget = { kind: 'paragraph'; nodeId: string; anchor: ParagraphAnchor; orphaned?: true; moved?: true };
const paraLink = (h: Host) => {
  const link = h.state.manifest.assetLinks?.find((l) => l.target.kind === 'paragraph');
  if (link === undefined) throw new Error('the paragraph link is gone');
  return link.target as ParaTarget;
};

describe('the body-write boundary maps paragraph links across every write', () => {
  it('doc.write editing the anchored paragraph in place remaps the anchor to the new text and revision', () => {
    const h = host();
    const before = paraLink(h);
    const next = BODY.replace('counted the gulls twice', 'counted the gulls three times');
    value(run(h, 'doc.write', { docId: LANDING, body: next }));
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    expect(after.moved).toBeUndefined();
    expect(after.anchor.exact).toContain('counted the gulls three times');
    expect(next.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
    expect(after.anchor.capturedRevision).toBe(before.anchor.capturedRevision + 1);
    expect(after.nodeId).toBe(LANDING);
  });

  it('doc.write moving the paragraph maps the anchor to its new position', () => {
    const h = host();
    const next = `${P3}\n\n${P1}\n\n${P2}\n`;
    value(run(h, 'doc.write', { docId: LANDING, body: next }));
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    expect(next.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
    expect(after.anchor.exact).toBe(P2);
  });

  it('doc.write deleting the anchored paragraph orphans the link and keeps the captured quote', () => {
    const h = host();
    value(run(h, 'doc.write', { docId: LANDING, body: `${P1}\n\n${P3}\n` }));
    const after = paraLink(h);
    expect(after.orphaned).toBe(true);
    expect(after.anchor.exact).toBe(P2);
  });

  it('editor.insert inside the anchored paragraph maps the anchor', () => {
    const h = host();
    const at = BODY.indexOf('did not trust');
    value(run(h, 'editor.insert', { docId: LANDING, offset: at, text: 'really ' }));
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    const body = getBody(h.state, LANDING);
    expect(body.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
    expect(after.anchor.exact).toContain('really did not trust');
  });

  it('editor.replaceRange rewriting the paragraph maps the anchor', () => {
    const h = host();
    const from = BODY.indexOf('Elena');
    const to = BODY.indexOf('first count.') + 'first count.'.length;
    value(run(h, 'editor.replaceRange', { docId: LANDING, range: { from, to }, text: 'Ansel counted the gulls once, and trusted it.' }));
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    const body = getBody(h.state, LANDING);
    expect(body.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
  });

  it('one undo restores the body and the captured prior links together, revision still rising', () => {
    const h = host();
    const before = JSON.parse(JSON.stringify(h.state.manifest.assetLinks)) as unknown;
    const revisionBefore = getRevision(h.state, LANDING);
    value(run(h, 'doc.write', { docId: LANDING, body: `${P1}\n\n${P3}\n` }));
    expect(paraLink(h).orphaned).toBe(true);
    undoLast(h);
    expect(getBody(h.state, LANDING)).toBe(BODY);
    expect(h.state.manifest.assetLinks).toEqual(before);
    expect(getRevision(h.state, LANDING)).toBe(revisionBefore + 2);
  });

  it('a write on a document with no paragraph links writes no assetLinks', () => {
    const state = project();
    state.manifest.assetLinks = [];
    const h = host(state);
    value(run(h, 'doc.write', { docId: LANDING, body: 'Rewritten.\n' }));
    expect(h.state.manifest.assetLinks).toEqual([]);
  });

  it('the default port maps links when the host injects no AnchorPort', () => {
    const h = host(project(), {});
    value(run(h, 'doc.write', { docId: LANDING, body: BODY.replace('all night', 'until midnight') }));
    expect(paraLink(h).orphaned).toBeUndefined();
  });

  it('an injected AnchorPort is the one that runs', () => {
    let calls = 0;
    const inner = paragraphAnchorPort();
    const counting: AnchorPort = {
      op: (input) => {
        calls += 1;
        expect(input.docId).toBe(LANDING);
        expect(input.oldBody).toBe(BODY);
        expect(input.links).toHaveLength(1);
        return inner.op(input);
      },
    };
    const h = host(project(), { anchors: counting });
    value(run(h, 'doc.write', { docId: LANDING, body: BODY.replace('did not trust', 'did not really trust') }));
    expect(calls).toBe(1);
    expect(paraLink(h).anchor.exact).toContain('did not really trust');
  });
});

/**
 * The recovery half of the boundary (`reconcileAdoptedBody`): a caller that replaces a body **outside** a command — a
 * pending-journal put-back, an encoding conversion, a snapshot restore, an external-write adoption — passes the same old/new
 * pair, and the links are reconciled the same way. No undo capture and no revision bump: the caller owns the write.
 *
 * This build's recovery paths all adopt a whole state, so their bodies and their links come from one save and there is nothing
 * to reconcile; the function is the API a caller that replaces one body needs, and these tests are its contract.
 */
describe('the recovery half of the boundary reconciles a body replaced outside a command', () => {
  it('maps an adopted body onto the anchor and leaves the revision to the caller', () => {
    const h = host();
    const before = paraLink(h);
    const adopted = `${P3}\n\n${P1}\n\n${P2.replace('twice', 'four times')}\n`;
    h.state.documents.get(LANDING)!.body = adopted;
    const revision = getRevision(h.state, LANDING);
    reconcileAdoptedBody(h.state, paragraphAnchorPort(), LANDING, BODY, adopted);
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    expect(adopted.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
    expect(after.anchor.exact).toContain('four times');
    expect(after.anchor.capturedRevision).toBe(before.anchor.capturedRevision);
    expect(getRevision(h.state, LANDING)).toBe(revision);
  });

  it('with no old body (a reload) runs the guarded resolver once and marks a found paragraph moved', () => {
    const h = host();
    // The writer edited the file in another program, so the old text is not available: the resolver has to search.
    const external = `${P3}\n\n${P1}\n\n${P2}\n`;
    h.state.documents.get(LANDING)!.body = external;
    reconcileAdoptedBody(h.state, paragraphAnchorPort(), LANDING, '', external);
    const after = paraLink(h);
    expect(after.orphaned).toBeUndefined();
    expect(after.moved).toBe(true);
    expect(external.slice(after.anchor.from, after.anchor.to)).toBe(after.anchor.exact);
  });

  it('leaves a document with no paragraph links and an unchanged body alone', () => {
    const h = host();
    const links = structuredClone(h.state.manifest.assetLinks);
    reconcileAdoptedBody(h.state, paragraphAnchorPort(), LANDING, BODY, BODY);
    expect(h.state.manifest.assetLinks).toEqual(links);
    h.state.manifest.assetLinks = [];
    reconcileAdoptedBody(h.state, paragraphAnchorPort(), LANDING, BODY, `${P1}\n`);
    expect(h.state.manifest.assetLinks).toEqual([]);
  });
});
