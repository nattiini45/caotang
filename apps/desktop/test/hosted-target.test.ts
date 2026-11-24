import { describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { RemoteConflictError } from '@caotang/remote-store';
import { HostedTarget, type HostedQueuePort, type HostedReplay, type HostedSaveSession } from '../src/app/hosted-target.js';

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

/** A queue as the adapter hands it to the target: paths held, and what a replay answers. */
function queue(initial: readonly string[], answer: () => Promise<HostedReplay> | HostedReplay = async () => ({ kind: 'sent', count: 1 })) {
  const held = new Set(initial);
  const calls: string[] = [];
  const port: HostedQueuePort = {
    hold: (changes) => {
      calls.push(`hold:${changes.map((change) => change.path).join(',')}`);
      for (const change of changes) held.add(change.path);
    },
    replay: async () => {
      calls.push('replay');
      const outcome = await answer();
      if (outcome.kind === 'sent') held.clear();
      return outcome;
    },
    forget: () => {
      calls.push('forget');
      held.clear();
    },
    held: () => [...held],
    marks: () => calls.push('marks'),
  };
  return { port, calls, held };
}

function withQueue(port: HostedQueuePort, save: (state: ProjectState) => Promise<unknown>): HostedTarget {
  return new HostedTarget('p_lighthouse', {} as never, save as never, port);
}

describe('the queue a hosted project keeps on this device', () => {
  it('holds what the server did not take, so a reload sends it instead of losing it', async () => {
    const held = queue([]);
    const saving = withQueue(held.port, async () => ({ kind: 'unavailable', changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] }));
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
    expect(held.calls).toEqual(['hold:docs/a.md']);
    expect(held.port.held()).toEqual(['docs/a.md']);
  });

  it('forgets the held words once a whole save lands, because that save carried them', async () => {
    const kept = queue(['docs/old.md']);
    const saving = withQueue(kept.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(kept.port.held()).toEqual([]);
    expect(kept.calls).toEqual(['forget', 'marks']);
  });

  it('replays an earlier tab’s words before the project is read, and keeps the marks after', async () => {
    const kept = queue(['docs/a.md']);
    const saving = withQueue(kept.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(saving.fromHeldQueue).toBe(true);
    expect(await saving.replayHeld()).toEqual({ kind: 'sent', count: 1 });
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(kept.calls).toContain('marks');
  });

  it('asks when the replayed words lose to another device, and keeps them queued', async () => {
    const kept = queue(['docs/a.md'], () => ({ kind: 'conflict', paths: ['docs/a.md'] }));
    const saving = withQueue(kept.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(await saving.replayHeld()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(kept.port.held()).toEqual(['docs/a.md']);
  });

  it('does nothing at open when no earlier tab left anything', async () => {
    const empty = queue([]);
    const saving = withQueue(empty.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(saving.fromHeldQueue).toBe(false);
    expect(await saving.replayHeld()).toBeNull();
    expect(empty.calls).toEqual([]);
  });
});
