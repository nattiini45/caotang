/**
 * *Make document-level* for a picture that lost its paragraph (pictures.md §2.3, §5), against the real command bus: the plan, the
 * compound command, what is kept (role, note), what is refused, and that one undo puts the lost placement back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandName,
  type UndoStore,
} from '@caotang/bus';
import { captureParagraphAnchor } from '@caotang/pictures';
import { addDocument, createEmptyManifest, createProjectCommandRegistry, createProjectState, type ProjectState } from '@caotang/store';

import type { StatusMessage } from '../src/components/shared.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { documentLevelPlanOf, lostParagraphsOf, repinBlockedText, repinPlanOf } from '../src/media/lost-paragraph-model.js';
import { makeDocumentLevel, repinPicture } from '../src/media/picture-actions.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const LANDING = 'n_7K2QX9M4A1';
const ONE = 'a_7K2QX9M4A1';
const TWO = 'a_3W8RN2TQ6C';
const BODY = 'The ferry was late.\n\nThe keeper waited on the jetty.';

beforeEach(() => activateEnglish());

function record(id: string) {
  return { id, file: `${id}.png`, mime: 'image/png' as const, sha256: id.slice(2).toLowerCase().padEnd(64, '0'), bytes: 100, createdAt: NOW.toISOString(), caption: id === ONE ? 'The jetty' : 'The chart' };
}

function anchor() {
  const captured = captureParagraphAnchor(BODY, BODY.indexOf('The keeper'), 1);
  if (captured === undefined) throw new Error('no paragraph to capture');
  return captured;
}

function orphan(id: string, assetId: string, extra: Record<string, unknown> = {}) {
  return { id, assetId, target: { kind: 'paragraph' as const, nodeId: LANDING, anchor: anchor(), orphaned: true as const }, role: 'reference' as const, order: 10, ...extra };
}

interface Session {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  dispatch(name: CommandName, params: Record<string, unknown>): ReturnType<typeof execute>;
  readonly said: StatusMessage[];
}

let ordinal = 0;
function session(links: readonly Record<string, unknown>[]): Session {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: BODY, now: NOW, id: LANDING });
  state.manifest.assets = [record(ONE), record(TWO)];
  state.manifest.assetLinks = links as never;
  const registry = createProjectCommandRegistry({ clock: { now: () => Date.parse('2026-10-09T10:00:00.000Z') } });
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
  return {
    state,
    undo,
    said: [],
    dispatch: (name, params) => {
      ordinal += 1;
      const command: Command = { id: `cmd_LOSTPARA${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
      return execute(command, bus, registry);
    },
  };
}

const linksOf = (s: Session) => s.state.manifest.assetLinks ?? [];
const undoLast = (s: Session): void => {
  const last = s.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = s.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
};

describe('the pictures that lost their paragraph', () => {
  it('lists the orphaned paragraph placements of one item, with the quote that was captured', () => {
    const s = session([
      orphan('l_1AAAAAAAAA', ONE, { note: 'Arrival' }),
      { ...orphan('l_2AAAAAAAAA', TWO), target: { kind: 'paragraph', nodeId: LANDING, anchor: anchor() } },
      { id: 'l_3AAAAAAAAA', assetId: TWO, target: { kind: 'node', nodeId: LANDING }, role: 'reference', order: 10 },
    ]);
    const lost = lostParagraphsOf(linksOf(s), LANDING);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ linkId: 'l_1AAAAAAAAA', assetId: ONE, nodeId: LANDING, quote: 'The keeper waited on the jetty.', note: 'Arrival' });
    expect(lostParagraphsOf(linksOf(s), 'n_3W8RN2TQ6C')).toEqual([]);
  });

  it('plans a move that keeps the role and note, and refuses a placement that did not lose its paragraph', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE, { note: 'Arrival', role: 'source' }), { ...orphan('l_2AAAAAAAAA', TWO), target: { kind: 'paragraph', nodeId: LANDING, anchor: anchor() } }]);
    expect(documentLevelPlanOf(linksOf(s), 'l_1AAAAAAAAA')).toEqual({ kind: 'move', assetId: ONE, nodeId: LANDING, role: 'source', note: 'Arrival' });
    expect(documentLevelPlanOf(linksOf(s), 'l_2AAAAAAAAA')).toEqual({ kind: 'refused', text: 'That picture has not lost its paragraph, so nothing was changed.' });
    expect(documentLevelPlanOf(linksOf(s), 'l_MISSINGAAA')).toMatchObject({ kind: 'refused' });
  });

  it('places the picture on the whole item with its note, takes the lost placement off, and says so', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE, { note: 'Arrival' })]);
    const said: StatusMessage[] = [];
    expect(makeDocumentLevel(s as never, (message) => said.push(message), 'l_1AAAAAAAAA', 'The jetty')).toBe(true);

    expect(linksOf(s)).toHaveLength(1);
    expect(linksOf(s)[0]).toMatchObject({ assetId: ONE, target: { kind: 'node', nodeId: LANDING }, role: 'reference', note: 'Arrival' });
    expect(lostParagraphsOf(linksOf(s), LANDING)).toEqual([]);
    expect(said).toEqual([{ text: 'The jetty is now placed on the whole item. Undo puts it back under its paragraph.', tone: 'info' }]);
  });

  it('one undo puts the lost placement back exactly as it was', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE, { note: 'Arrival' })]);
    const before = JSON.parse(JSON.stringify(linksOf(s))) as unknown;
    makeDocumentLevel(s as never, () => undefined, 'l_1AAAAAAAAA', 'The jetty');
    expect(s.undo.groups()).toHaveLength(1);
    undoLast(s);
    expect(JSON.parse(JSON.stringify(linksOf(s)))).toEqual(before);
  });

  it('only takes the lost placement off when the item already holds the picture', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE), { id: 'l_2AAAAAAAAA', assetId: ONE, target: { kind: 'node', nodeId: LANDING }, role: 'reference', order: 10, note: 'Kept' }]);
    const said: StatusMessage[] = [];
    expect(documentLevelPlanOf(linksOf(s), 'l_1AAAAAAAAA')).toEqual({ kind: 'merge', assetId: ONE, nodeId: LANDING });
    expect(makeDocumentLevel(s as never, (message) => said.push(message), 'l_1AAAAAAAAA', 'The jetty')).toBe(true);
    expect(linksOf(s)).toHaveLength(1);
    expect(linksOf(s)[0]).toMatchObject({ id: 'l_2AAAAAAAAA', note: 'Kept' });
    expect(said[0]?.text).toBe('The jetty was already placed on this item, so its lost paragraph placement was taken off. Undo puts it back.');
    undoLast(s);
    expect(linksOf(s)).toHaveLength(2);
  });

  it('changes nothing and says why for a placement that still has its paragraph', () => {
    const s = session([{ ...orphan('l_2AAAAAAAAA', TWO), target: { kind: 'paragraph', nodeId: LANDING, anchor: anchor() } }]);
    const before = JSON.parse(JSON.stringify(linksOf(s))) as unknown;
    const said: StatusMessage[] = [];
    expect(makeDocumentLevel(s as never, (message) => said.push(message), 'l_2AAAAAAAAA', 'The chart')).toBe(false);
    expect(JSON.parse(JSON.stringify(linksOf(s)))).toEqual(before);
    expect(said).toEqual([{ text: 'That picture has not lost its paragraph, so nothing was changed.', tone: 'error' }]);
    expect(s.undo.groups()).toHaveLength(0);
  });
});

describe('Re-pin for a picture that lost its paragraph', () => {
  const node = { id: LANDING, type: 'document' };
  const SECOND = BODY.indexOf('The keeper');
  const caret = (extra: Record<string, unknown> = {}) => ({ docId: LANDING, from: SECOND, to: SECOND + 10, dirty: false, ...extra });

  it('says why the selection cannot be used, by the same rules as Attach to this paragraph', () => {
    expect(repinBlockedText(caret(), node)).toBeNull();
    expect(repinBlockedText(null, node)).toBe('Select text in the paragraph you want, in this document, to re-pin a picture to it.');
    expect(repinBlockedText(caret({ from: 5, to: 5 }), node)).toContain('Select text');
    expect(repinBlockedText(caret({ docId: 'n_3W8RN2TQ6C' }), node)).toContain('Select text');
    expect(repinBlockedText(caret({ dirty: true }), node)).toBe('Re-pinning waits for the text to be saved.');
    expect(repinBlockedText(caret(), { id: LANDING, type: 'folder' })).toContain('Select text');
  });

  it('refuses without a selection and leaves the lost placement and the undo history alone', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE)]);
    const before = JSON.parse(JSON.stringify(linksOf(s))) as unknown;
    for (const bad of [null, caret({ from: 4, to: 4 }), caret({ dirty: true }), caret({ docId: 'n_3W8RN2TQ6C' })]) {
      const said: StatusMessage[] = [];
      expect(repinPicture(s as never, (message) => said.push(message), 'l_1AAAAAAAAA', 'The jetty', bad, node)).toBe(false);
      expect(said).toHaveLength(1);
      expect(said[0]?.tone).toBe('error');
    }
    expect(JSON.parse(JSON.stringify(linksOf(s)))).toEqual(before);
    expect(s.undo.groups()).toHaveLength(0);
  });

  it('refuses a placement that still has its paragraph or belongs to another document', () => {
    const s = session([{ ...orphan('l_2AAAAAAAAA', TWO), target: { kind: 'paragraph', nodeId: LANDING, anchor: anchor() } }, orphan('l_1AAAAAAAAA', ONE)]);
    expect(repinPlanOf(linksOf(s), 'l_2AAAAAAAAA', caret(), node)).toEqual({ kind: 'refused', text: 'That picture has not lost its paragraph, so nothing was changed.' });
    expect(repinPlanOf(linksOf(s), 'l_MISSINGAAA', caret(), node)).toMatchObject({ kind: 'refused' });
    expect(repinPlanOf(linksOf(s), 'l_1AAAAAAAAA', caret(), { id: 'n_3W8RN2TQ6C', type: 'document' })).toMatchObject({ kind: 'refused' });
  });

  it('pins to the selected paragraph through asset.repin, clears orphaned, and one undo restores the lost state', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE, { note: 'Arrival' })]);
    const before = JSON.parse(JSON.stringify(linksOf(s))) as unknown;
    const said: StatusMessage[] = [];
    const first = caret({ from: 2, to: 8 });
    expect(repinPlanOf(linksOf(s), 'l_1AAAAAAAAA', first, node)).toEqual({ kind: 'repin', linkId: 'l_1AAAAAAAAA', selection: { from: 2, to: 8 } });
    expect(repinPicture(s as never, (message) => said.push(message), 'l_1AAAAAAAAA', 'The jetty', first, node)).toBe(true);

    expect(lostParagraphsOf(linksOf(s), LANDING)).toEqual([]);
    const target = linksOf(s)[0]?.target as { kind: string; orphaned?: unknown; anchor: { exact: string } };
    expect(target.kind).toBe('paragraph');
    expect(target.orphaned).toBeUndefined();
    expect(target.anchor.exact).toBe('The ferry was late.');
    expect(linksOf(s)[0]).toMatchObject({ id: 'l_1AAAAAAAAA', note: 'Arrival' });
    expect(said).toEqual([{ text: 'The jetty is now pinned to the paragraph you selected. Undo puts it back as it was.', tone: 'info' }]);

    expect(s.undo.groups()).toHaveLength(1);
    undoLast(s);
    expect(JSON.parse(JSON.stringify(linksOf(s)))).toEqual(before);
  });

  it('reports the command refusal honestly when the selection is past the stored text', () => {
    const s = session([orphan('l_1AAAAAAAAA', ONE)]);
    const before = JSON.parse(JSON.stringify(linksOf(s))) as unknown;
    const said: StatusMessage[] = [];
    expect(repinPicture(s as never, (message) => said.push(message), 'l_1AAAAAAAAA', 'The jetty', caret({ from: BODY.length + 5, to: BODY.length + 9 }), node)).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]?.tone).toBe('error');
    expect(JSON.parse(JSON.stringify(linksOf(s)))).toEqual(before);
    expect(s.undo.groups()).toHaveLength(0);
  });
});