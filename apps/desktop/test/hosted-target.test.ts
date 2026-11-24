import { describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { RemoteConflictError } from '@caotang/remote-store';
import { HostedTarget, type HostedSaveSession } from '../src/app/hosted-target.js';

const T0 = new Date('2026-11-24T09:00:00.000Z');

function state(): ProjectState {
  return createProjectState(createEmptyManifest('The Lighthouse', T0));
}

/** A session as the target uses it: the state, and the browser save's own signal. */
function session(current: ProjectState): HostedSaveSession & { saved(): void; readonly listeners: Set<() => void> } {
  const listeners = new Set<() => void>();
  let status = 'idle';
  return {
    listeners,
    state: current,
    persistence: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getStatus: () => status,
    },
    saved() {
      status = 'saved';
      for (const listener of listeners) listener();
    },
  };
}

function target(save: (state: ProjectState) => Promise<unknown>): HostedTarget {
  return new HostedTarget('p_lighthouse', {} as never, save as never);
}

describe('the account as a session’s save target', () => {
  it('saves after each save this browser finishes, and says nothing when it lands', async () => {
    const project = state();
    const owner = session(project);
    const states: string[] = [];
    const saving = target(async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    saving.subscribe(() => states.push(saving.state().kind));
    saving.attach(owner);

    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toEqual(['saving', 'idle']);
  });

  it('names the documents another device changed, and writes nothing', async () => {
    const owner = session(state());
    const saving = target(async () => ({ kind: 'conflict', paths: ['docs/n_3W8RN2TQ6C.md'], changes: [] }));
    saving.attach(owner);
    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/n_3W8RN2TQ6C.md'] });
  });

  it('says the account is behind this browser when the server does not answer', async () => {
    const owner = session(state());
    const saving = target(async () => ({ kind: 'unavailable', changes: [] }));
    saving.attach(owner);
    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saving.state()).toEqual({ kind: 'unsaved' });
  });

  it('writes this device’s text on top of the other device’s version when the writer says so', async () => {
    const owner = session(state());
    const refreshed: string[] = [];
    const committed: string[] = [];
    const saving = new HostedTarget('p_lighthouse', {
      refresh: async () => { refreshed.push('refresh'); },
      commitChanges: async (changes: readonly { readonly path: string }[]) => { committed.push(...changes.map((change) => change.path)); },
    } as never, (async () => ({ kind: 'conflict', paths: ['docs/a.md'], changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] })) as never);
    saving.attach(owner);
    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saving.state().kind).toBe('conflict');

    expect(await saving.keepMine()).toEqual({ kind: 'idle' });
    expect(refreshed).toEqual(['refresh']);
    expect(committed).toEqual(['docs/a.md']);
  });

  it('reports a save the account refused as unsaved rather than as landed', async () => {
    const saving = new HostedTarget('p_lighthouse', {
      refresh: async () => {},
      commitChanges: async () => { throw new RemoteConflictError(['docs/a.md']); },
    } as never, (async () => ({ kind: 'conflict', paths: ['docs/a.md'], changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] })) as never);
    expect(await saving.keepMine()).toEqual({ kind: 'unsaved' });
  });
});

describe('a save that fails in a way the target has no answer for', () => {
  it('says the account is behind instead of staying in the saving state', async () => {
    const saving = target(async () => {
      throw new Error('The account is full.');
    });
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
  });

  it('lets the writer send it again once the refusal is gone', async () => {
    let refuse = true;
    const saving = target(async () => {
      if (refuse) throw new Error('The account is full.');
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    });
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
    refuse = false;
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'idle' });
  });
});

describe('the answer to a conflict this session’s own save raised', () => {
  it('runs the whole save again against the other device’s version, so a deleted document comes back with its body', async () => {
    const saves: ProjectState[] = [];
    const committed: unknown[] = [];
    const outcomes = [
      { kind: 'conflict', paths: ['docs/a.md'], changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] },
      { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } },
    ];
    const saving = new HostedTarget('p_lighthouse', {
      refresh: async () => undefined,
      commitChanges: async (changes: readonly unknown[]) => committed.push(changes),
    } as never, (async (current: ProjectState) => {
      saves.push(current);
      return outcomes.shift();
    }) as never);
    const current = state();
    await saving.save(current);
    expect(saving.state().kind).toBe('conflict');

    expect(await saving.keepMine(current)).toEqual({ kind: 'idle' });
    // The state itself is the answer: a partial replay of the staged paths could write a manifest naming a document whose file
    // the other device deleted, and the whole save run again writes the body with it.
    expect(saves).toEqual([current, current]);
    expect(committed).toEqual([]);
  });

  it('sends the project’s pictures with the save that names them', async () => {
    const seen: unknown[] = [];
    const saving = target(async (_state, assets) => {
      seen.push(assets);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    });
    const one = { files: { 'assets/c_2K4Q9WJ1TT.png': new Uint8Array([7]) }, complete: true };
    saving.attach({ ...session(state()), assets: async () => one });
    await saving.save(state());
    expect(seen).toEqual([one]);
  });
});
