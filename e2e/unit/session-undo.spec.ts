import { expect, test } from '@playwright/test';

import {
  MemoryIndexedDb,
  getBody,
  getRevision,
  openRuntimeStore,
  type CodexEntry,
  type ProjectState,
} from '../../packages/store/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';

import { IDS, project } from './fixtures.js';

/**
 * Undo as the session runs it. An undo puts a body back by writing the earlier body through the same path as any
 * other write (command-bus §5), so two things follow that the parts cannot show alone: a change cannot be taken back
 * while a later change to the same text stands, and the revision moves up past the undo, so the mention cache counts
 * the text the store holds and never a number it saw before.
 *
 * The session wires its autosave to the page's visibility and page-hide events, which this file stands in for with
 * event targets, since Node has none of the page.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

async function sessionFor(state: ProjectState): Promise<ProjectSession> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

/** A codex entry with the fields a detection pass reads. Only the name matters to these tests. */
function codexEntry(id: string, name: string): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: 'Keeps the lighthouse.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  };
}

test('an older change cannot be undone while a later one stands, and the later text is kept', async () => {
  const session = await sessionFor(project());
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one' });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one two' });
    const groups = session.undo.groups();
    const older = groups[0]!.id;
    const newer = groups[1]!.id;
    expect(session.newestUndoGroupId()).toBe(newer);

    // Taking back the first write would restore the body from before it, and so delete the second write's text.
    expect(await session.undoGroup(older)).toBe(false);
    expect(getBody(session.state, IDS.sceneA)).toBe('one two');
    expect(session.undoErrorMessage()).toContain('Undo the later changes first');

    expect(await session.undoGroup(newer)).toBe(true);
    expect(getBody(session.state, IDS.sceneA)).toBe('one');
    expect(await session.undoGroup(older)).toBe(true);
    expect(getBody(session.state, IDS.sceneA)).toBe('Four little words here');

    // A group taken back is gone from the store, and asking for it again says so rather than failing quietly.
    expect(await session.undoGroup(older)).toBe(false);
    expect(session.undoErrorMessage()).toContain('already been undone');
  } finally {
    session.close();
  }
});

test('an undo followed by new text is counted from the new text, at a revision the undo moved past', async () => {
  const state = project();
  const elena = codexEntry('c_ELENA00001', 'Elena');
  state.manifest.codex = [elena];
  const session = await sessionFor(state);
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Elena walked and sat.' });
    const written = getRevision(session.state, IDS.sceneA);
    const counted = session.mentions.countsIn(session.state, IDS.sceneA, session.mentions.entriesOf(session.state));
    expect(counted.get(elena.id)).toBe(1);

    expect(await session.undoLast()).toBe(true);
    // The undo is a write, so the revision is one above the count's and the text is the earlier one again.
    expect(getRevision(session.state, IDS.sceneA)).toBe(written + 1);

    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Lena sat.' });
    // Two above the count's revision, over text that does not name her: a revision the count never saw.
    expect(getRevision(session.state, IDS.sceneA)).toBe(written + 2);
    const recounted = session.mentions.countsIn(session.state, IDS.sceneA, session.mentions.entriesOf(session.state));
    expect(recounted.get(elena.id) ?? 0).toBe(0);
  } finally {
    session.close();
  }
});

test('restoring to before a change takes back every later change, newest first, and leaves the older ones standing', async () => {
  const session = await sessionFor(project());
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one' });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one two' });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one two three' });
    const [older, turn, later] = session.undo.groups().map((group) => group.id);

    // The turn is the middle change: the typing after it is a change made later, and it goes back with the turn.
    expect(session.laterChangesAfter(turn!)).toHaveLength(1);
    expect(await session.restoreBefore(turn!)).toEqual({ ok: true, later: 1, undone: [later, turn] });
    expect(getBody(session.state, IDS.sceneA)).toBe('one');
    expect(session.undo.group(later!)).toBeUndefined();
    expect(session.undo.group(older!)).toBeDefined();

    // The change before the turn is still on the stack, and it is the newest now, so it can be taken back in its turn.
    expect(session.newestUndoGroupId()).toBe(older);
    expect(await session.undoLast()).toBe(true);
    expect(getBody(session.state, IDS.sceneA)).toBe('Four little words here');

    // A turn taken back is gone from the stack, and asking again says so rather than changing anything.
    expect(await session.restoreBefore(turn!)).toEqual({
      ok: false,
      message: 'That change has already been undone, so there is nothing to take back.',
      undone: [],
    });
  } finally {
    session.close();
  }
});
