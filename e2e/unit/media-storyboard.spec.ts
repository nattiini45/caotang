import { expect, test } from '@playwright/test';

import type { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { commitShotCommand } from '../../apps/desktop/src/media/commit.js';
import type { ShotCommand } from '../../apps/desktop/src/media/engines.js';
import type { MediaPorts } from '../../apps/desktop/src/media/ports.js';
import {
  draftOf,
  moveShotCommand,
  newShotParams,
  shotCardsOf,
  shotEditCommand,
  type ShotCard,
  type ShotDraft,
} from '../../apps/desktop/src/media/storyboard-model.js';
import { applyStoryboardCommands, addShotNode, addStoryboardFolder, shotsIn } from '../../packages/storyboard/src/index.js';
import { createEmptyManifest, createProjectState, type ProjectState } from '../../packages/store/src/index.js';

const NOW = new Date('2026-10-08T09:00:00Z');
const FOLDER = 'n_SBFOLDER01';

/** A project with one storyboard folder, and the shots the test names, in the order given. */
function storyboard(shots: readonly { id: string; title: string; stored?: unknown }[]): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  for (const shot of shots) {
    addShotNode(state, { parentId: FOLDER, id: shot.id, title: shot.title, stored: shot.stored ?? {}, now: NOW });
  }
  return state;
}

const THREE = [
  { id: 'n_SHOTA00001', title: 'Wide' },
  { id: 'n_SHOTB00001', title: 'Close' },
  { id: 'n_SHOTC00001', title: 'Insert' },
] as const;

function titlesIn(state: ProjectState): string[] {
  return shotsIn(state, FOLDER).map((node) => node.title);
}

/** The command a reorder plans, for a test that expects the plan to succeed. */
function planMove(state: ProjectState, shotId: string, index: number): ShotCommand {
  const planned = moveShotCommand(state, shotId, index);
  if (!planned.ok) throw new Error(planned.refusal.message);
  return planned.value;
}

/** Applies one planned command to a copy, the way the bus applies it, and returns the copy. */
function applied(state: ProjectState, command: ShotCommand): ProjectState {
  const copy = structuredClone(state);
  const result = applyStoryboardCommands(copy, [command]);
  if (!result.ok) throw new Error(result.refusal.message);
  return copy;
}

/** A session stub that records what the view dispatches. The commit path is the only thing it is used for. */
function stubSession(answer: { ok: true } | { ok: false; error: { code: string; message: string; correctiveHint?: string } } = { ok: true }) {
  const calls: { name: string; params: unknown }[] = [];
  const session = {
    dispatch: (name: string, params: unknown) => {
      calls.push({ name, params });
      return answer.ok ? { ok: true, value: {} } : { ok: false, error: answer.error };
    },
  } as unknown as ProjectSession;
  return { session, calls };
}

function cardOf(state: ProjectState, title: string): ShotCard {
  const card = shotCardsOf(state, FOLDER).find((candidate) => candidate.title === title);
  if (card === undefined) throw new Error(`no card "${title}"`);
  return card;
}

test.describe('the cards', () => {
  test('a card is numbered by its place in the folder, and a reorder renumbers the cards', () => {
    const state = storyboard(THREE);
    expect(shotCardsOf(state, FOLDER).map((card) => `${card.number}:${card.title}`)).toEqual(['1:Wide', '2:Close', '3:Insert']);
    const moved = applied(state, planMove(state, THREE[2].id, 0));
    expect(shotCardsOf(moved, FOLDER).map((card) => `${card.number}:${card.title}`)).toEqual(['1:Insert', '2:Wide', '3:Close']);
  });

  test('the spec row reads the camera fields and the duration, and leaves out what is unset', () => {
    const state = storyboard([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { shotSize: 'MS', cameraAngle: 'low', cameraMovement: 'dolly-in', durationSec: 4.5 } },
      { id: 'n_SHOTB00001', title: 'Blank' },
    ]);
    expect(cardOf(state, 'Wide').spec).toBe('Medium shot (MS) · Low angle · Dolly in · 4.5 s');
    expect(cardOf(state, 'Blank').spec).toBe('');
  });

  test('an enum value outside its list still shows, and is reported on the card rather than dropped', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide', stored: { shotSize: 'XXL' } }]);
    const card = cardOf(state, 'Wide');
    expect(card.spec).toBe('XXL');
    expect(card.unknown).toEqual(['shotSize "XXL" is not in the v1 list']);
  });

  test('a field of the wrong type is dropped with a notice, and the rest of the shot still reads', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide', stored: { action: 42, lens: '35mm' } }]);
    const card = cardOf(state, 'Wide');
    expect(card.action).toBe('');
    expect(card.lens).toBe('35mm');
    expect(card.notices).toContain('action is not text; dropped');
  });

  test('the covered lines are counted from the dialogue anchors', () => {
    const anchor = { from: 0, to: 4, exact: 'ANNA', prefix: '', suffix: '', capturedRevision: 1 };
    const state = storyboard([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { dialogue: [{ kind: 'fountain-element', docId: 'n_SCENE00001', anchor }] } },
    ]);
    expect(cardOf(state, 'Wide').coverage).toBe(1);
  });

  test('an image is the asset id when the shot names a valid one, and is absent for a path', () => {
    const state = storyboard([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { image: 'a_0123456789' } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { image: 'docs/wide.png' } },
    ]);
    expect(cardOf(state, 'Wide').image).toBe('a_0123456789');
    expect(cardOf(state, 'Close').image).toBeNull();
    expect(cardOf(state, 'Close').notices.join(' ')).toContain('not an asset id');
  });

  test('a folder with no shots has no cards', () => {
    const state = storyboard([]);
    expect(shotCardsOf(state, FOLDER)).toEqual([]);
  });
});

test.describe('reordering', () => {
  test('a shot moved later lands after the shots it passes, and the engine counts the others, not itself', () => {
    const state = storyboard(THREE);
    const planned = moveShotCommand(state, THREE[0].id, 1);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toEqual({ name: 'binder.move', params: { nodeId: THREE[0].id, newParentId: FOLDER, index: 1 } });
    expect(titlesIn(applied(state, planned.value))).toEqual(['Close', 'Wide', 'Insert']);
  });

  test('a shot moved earlier and a shot moved to the front or the end all land where the card shows', () => {
    const state = storyboard(THREE);
    const step = (id: string, index: number): string[] => {
      const planned = moveShotCommand(state, id, index);
      if (!planned.ok) throw new Error(planned.refusal.message);
      return titlesIn(applied(state, planned.value));
    };
    expect(step(THREE[1].id, 0)).toEqual(['Close', 'Wide', 'Insert']);
    expect(step(THREE[2].id, 0)).toEqual(['Insert', 'Wide', 'Close']);
    expect(step(THREE[0].id, 2)).toEqual(['Close', 'Insert', 'Wide']);
  });

  test('a position outside the folder is refused, and the refusal says the range', () => {
    const state = storyboard(THREE);
    const planned = moveShotCommand(state, THREE[0].id, 3);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('out-of-range');
    expect(planned.refusal.message).toContain('1 to 3');
  });

  test('a node that is not a shot cannot be moved', () => {
    const state = storyboard(THREE);
    const planned = moveShotCommand(state, FOLDER, 0);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('not-a-shot');
  });
});

test.describe('editing a shot', () => {
  test('an edit writes the fields the writer changed and keeps the rest, guarded by the value it read', () => {
    const stored = { shotSize: 'MS', lens: '35mm', action: 'Old' };
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide', stored }]);
    const card = cardOf(state, 'Wide');
    const edited: ShotDraft = { ...draftOf(card), action: 'New' };
    const planned = shotEditCommand(state, card.id, edited);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.name).toBe('shot.setMeta');
    expect(planned.value.params).toEqual({ nodeId: card.id, stored: { shotSize: 'MS', lens: '35mm', action: 'New' }, expect: stored });
  });

  test('clearing every field stores no value at all, so the shot is left without metadata', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide', stored: { lens: '35mm' } }]);
    const cleared: ShotDraft = { shotSize: '', cameraAngle: '', cameraMovement: '', transition: '', lens: '', action: '', durationSec: '', imageAlt: '' };
    const planned = shotEditCommand(state, 'n_SHOTA00001', cleared);
    expect(planned.ok).toBe(true);
    if (!planned.ok || planned.value.name !== 'shot.setMeta') return;
    expect(planned.value.params.stored).toBeNull();
  });

  test('a duration that is not a number of seconds at least zero is refused', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide' }]);
    const draft = (durationSec: string): ShotDraft => ({ ...draftOf(cardOf(state, 'Wide')), durationSec });
    for (const bad of ['-1', 'soon']) {
      const planned = shotEditCommand(state, 'n_SHOTA00001', draft(bad));
      expect(planned.ok, bad).toBe(false);
      if (!planned.ok) expect(planned.refusal.code).toBe('duration-invalid');
    }
  });

  test('an enum value outside its list is refused, and the refusal names the list', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide' }]);
    const planned = shotEditCommand(state, 'n_SHOTA00001', { ...draftOf(cardOf(state, 'Wide')), shotSize: 'XXL' });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('enum-invalid');
    expect(planned.refusal.message).toContain('v1 values');
  });

  test('an action over the limit is refused, and the refusal says how far over', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide' }]);
    const planned = shotEditCommand(state, 'n_SHOTA00001', { ...draftOf(cardOf(state, 'Wide')), action: 'x'.repeat(1001) });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('action-too-long');
    expect(planned.refusal.message).toContain('1001 characters');
  });

  test('a value the load kept as unknown must be picked from the list before the shot saves', () => {
    const state = storyboard([{ id: 'n_SHOTA00001', title: 'Wide', stored: { shotSize: 'XXL' } }]);
    const planned = shotEditCommand(state, 'n_SHOTA00001', draftOf(cardOf(state, 'Wide')));
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('enum-invalid');
  });

  test('a shot the state no longer holds is refused by name', () => {
    const state = storyboard(THREE);
    const planned = shotEditCommand(state, 'n_GONE000001', draftOf(cardOf(state, 'Wide')));
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('not-a-shot');
  });
});

test.describe('the commit path', () => {
  test('a shot edit with no port is dispatched to the bus as shot.setMeta, which the desktop registers now', () => {
    const state = storyboard(THREE);
    const planned = shotEditCommand(state, THREE[0].id, { ...draftOf(cardOf(state, 'Wide')), lens: '35mm' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { session, calls } = stubSession();
    expect(commitShotCommand(session, planned.value, undefined)).toEqual({ ok: true });
    expect(calls.map((call) => call.name)).toEqual(['shot.setMeta']);
  });

  test('a reorder is dispatched to the bus as binder.move, with the index the engine planned', () => {
    const state = storyboard(THREE);
    const planned = moveShotCommand(state, THREE[0].id, 2);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { session, calls } = stubSession();
    expect(commitShotCommand(session, planned.value, undefined)).toEqual({ ok: true });
    expect(calls).toEqual([{ name: 'binder.move', params: { nodeId: THREE[0].id, newParentId: FOLDER, index: 2 } }]);
  });

  test('the App port takes over every commit, and the bus is then not called', () => {
    const state = storyboard(THREE);
    const planned = shotEditCommand(state, THREE[0].id, { ...draftOf(cardOf(state, 'Wide')), lens: '35mm' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const seen: string[] = [];
    const ports: MediaPorts = {
      commitShot: (command) => {
        seen.push(command.name);
        return { ok: true };
      },
    };
    const { session, calls } = stubSession();
    expect(commitShotCommand(session, planned.value, ports)).toEqual({ ok: true });
    expect(seen).toEqual(['shot.setMeta']);
    expect(calls).toEqual([]);
  });

  test('a refusal from the bus is shown in the words the bus gives, corrective hint included', () => {
    const state = storyboard(THREE);
    const planned = moveShotCommand(state, THREE[0].id, 1);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { session } = stubSession({ ok: false, error: { code: 'not-found', message: 'no node to move', correctiveHint: 'read the tree again' } });
    expect(commitShotCommand(session, planned.value, undefined)).toEqual({ ok: false, message: 'no node to move. read the tree again.' });
  });
});

test.describe('adding a shot', () => {
  test('a new shot is a binder.create of type shot under the storyboard folder (storyboard.md §3.1), with no new command', () => {
    const state = storyboard(THREE);
    expect(newShotParams(state, FOLDER)).toEqual({ ok: true, value: { parentId: FOLDER, type: 'shot', title: 'New shot' } });
  });

  test('a new shot is refused outside a storyboard folder, and the refusal says which kind of folder it needs', () => {
    const state = storyboard(THREE);
    const planned = newShotParams(state, 'manuscript');
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe('not-a-storyboard');
    expect(planned.refusal.message).toContain('storyboard folder');
  });
});
