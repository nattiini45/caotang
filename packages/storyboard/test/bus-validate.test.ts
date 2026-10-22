/**
 * The three storyboard commands through the bus, on the wiring the app and the harness use: the store's
 * registry with this module's own port, and a bus that reads the live project state.
 *
 * Command-bus §2: a command that passes validation cannot fail mid-apply for validation reasons. These
 * three commands depend on the project — the folder a storyboard lands in, the storyboard folder a shot
 * lands in, the shot a metadata change names — so their validate reads that project and refuses a command
 * whose target is gone, before the apply is reached.
 *
 * The refusal proves which half refused it: the bus's own refusal names the missing node and carries no
 * storyboard code, while the module's own refusal (from the apply) carries `details.storyboardCode`.
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
  type CommandRegistry,
} from '@caotang/bus';

import { createProjectCommandRegistry, getRevision, removeNode, type ProjectState } from '@caotang/store';

import { addShotNode, shotCommandPort } from '../src/index.js';

import { NOW, buildFixture, treeSnapshot } from './fixtures.js';

/** The bus the app (apps/desktop/src/app/session.ts) and the harness (packages/harness/src/runtime.ts) build: the store's registry with this module's port, reading the live state. */
function harness(state: ProjectState): { readonly bus: BusContext<ProjectState>; readonly registry: CommandRegistry } {
  const registry: CommandRegistry = createProjectCommandRegistry({ shots: shotCommandPort() });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return { bus, registry };
}

function agent(name: 'storyboard.create' | 'shot.create' | 'shot.setMeta', params: Record<string, unknown>, callId: string): Command {
  return { id: `cmd_${callId}`, name, params, issuedBy: 'agent', turnId: 'turn-1', callId, createdAt: 1 };
}

describe('a storyboard plan whose target is gone is refused at validate, not at apply', () => {
  it('refuses a storyboard whose parent folder was deleted after the plan was made', () => {
    const { state } = buildFixture();
    const revision = getRevision(state, 'scene1');
    const { bus, registry } = harness(state);
    // The folder the plan named is gone; the scene that lived in it went with it.
    removeNode(state, 'act1');
    const before = treeSnapshot(state);

    const result = execute(
      agent(
        'storyboard.create',
        { id: 'n_BRD0000001', parentId: 'act1', title: 'Harbour — Shots', scene: { id: 'scene1', parentId: 'act1', revision } },
        'board-gone',
      ),
      bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The bus's own refusal: it names the node that is missing, and it carries no storyboard code,
    // so the module's apply was never reached.
    expect(result.error.code).toBe('not-found');
    expect(result.error.message).toContain('no node with id "act1"');
    expect(result.error.target).toBe('act1');
    expect(result.error.details?.['storyboardCode']).toBeUndefined();
    expect(treeSnapshot(state)).toBe(before);
  });

  it('refuses a metadata change for a shot that was removed after the plan was made', () => {
    const { state } = buildFixture();
    addShotNode(state, { parentId: 'board1', title: 'one', stored: { action: 'a' }, id: 'n_SHT0000001', now: NOW });
    const { bus, registry } = harness(state);
    removeNode(state, 'n_SHT0000001');
    const before = treeSnapshot(state);

    const result = execute(
      agent('shot.setMeta', { nodeId: 'n_SHT0000001', stored: { action: 'b' }, expect: { action: 'a' } }, 'meta-gone'),
      bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
    expect(result.error.message).toContain('no node with id "n_SHT0000001"');
    expect(result.error.details?.['storyboardCode']).toBeUndefined();
    expect(treeSnapshot(state)).toBe(before);
  });

  it('refuses a shot that names a folder which is not a storyboard, before the apply', () => {
    const { state } = buildFixture();
    const { bus, registry } = harness(state);
    const before = treeSnapshot(state);

    const result = execute(
      agent('shot.create', { id: 'n_SHT0000002', parentId: 'act1', title: 'Elena', stored: {} }, 'shot-not-a-board'),
      bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.target).toBe('parentId');
    expect(result.error.details?.['storyboardCode']).toBeUndefined();
    expect(treeSnapshot(state)).toBe(before);
  });
});

describe('the derive still runs, because the bus reads the live tree', () => {
  it('creates a board and a shot in it, one command after the other', () => {
    // The derive dispatches its commands in order: the shot names the board the previous command created.
    // That only validates if the bus reads the state the apply just wrote.
    const { state } = buildFixture();
    const revision = getRevision(state, 'scene1');
    const { bus, registry } = harness(state);

    const board = execute(
      agent(
        'storyboard.create',
        { id: 'n_BRD0000002', parentId: 'act1', title: 'Harbour — Shots', scene: { id: 'scene1', parentId: 'act1', revision } },
        'board-1',
      ),
      bus,
      registry,
    );
    // Thrown rather than expected: the shot dispatch below depends on the board
    // having landed, and a bare `expect(board.ok).toBe(true)` would discard the
    // refusal's code and message — the only diagnostics that say why the derive
    // broke.
    if (!board.ok) throw new Error(`storyboard.create was refused: ${board.error.code}: ${board.error.message}`);

    const shot = execute(
      agent('shot.create', { id: 'n_SHT0000003', parentId: 'n_BRD0000002', title: 'Elena', stored: { action: 'a' } }, 'shot-1'),
      bus,
      registry,
    );
    if (!shot.ok) throw new Error(`shot.create was refused: ${shot.error.code}: ${shot.error.message}`);

    expect(state.manifest.tree.find((node) => node.id === 'n_SHT0000003')?.parentId).toBe('n_BRD0000002');
  });
});
