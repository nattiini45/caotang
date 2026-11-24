import { describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { RemoteConflictError } from '@caotang/remote-store';
import { HostedTarget, type HostedQueuePort, type HostedSaveSession } from '../src/app/hosted-target.js';

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

function target(save: (state: ProjectState) => Promise<unknown>, versions: Record<string, number> = {}): HostedTarget {
  return new HostedTarget('p_lighthouse', { versionOf: (path: string) => versions[path] ?? 0 } as never, save as never);
}

/** A queue that holds what a save could not write, so a picture's conflict can be read back. */
function holdingQueue(): { port: HostedQueuePort; held(): string[] } {
  const paths = new Set<string>();
  return {
    port: {
      hold: (changes) => { for (const change of changes) paths.add(change.path); },
      replay: async () => ({ kind: 'sent', count: 0 }),
      forget: (named) => { if (named === undefined) paths.clear(); else for (const path of named) paths.delete(path); },
      held: () => [...paths],
      marks: () => {},
    },
    held: () => [...paths],
  };
}

describe('the account as a session’s save target', () => {
  it('writes the picture the writer answered for, instead of asking the same question again', async () => {
    const seen: { assets?: { files: Record<string, Uint8Array> } }[] = [];
    let coverVersion = 1;
    const coverage = new Uint8Array([1]);
    const mine = new Uint8Array([2]);
    const saving = new HostedTarget('p_lighthouse', {
      refresh: async () => { coverVersion = 2; },
      versionOf: (path: string) => (path === 'assets/c_2K4Q9WJ1TT.png' ? coverVersion : 0),
    } as never, (async (_state, options) => {
      seen.push(options as never);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    }) as never);
    const project = state();
    saving.attach({ ...session(project), assets: async () => ({ 'assets/c_2K4Q9WJ1TT.png': mine }) });
    await saving.rememberOpened(project.documents.keys(), { 'assets/c_2K4Q9WJ1TT.png': coverage });
    coverVersion = 2;
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['assets/c_2K4Q9WJ1TT.png'] });

    expect(await saving.keepMine(project)).toEqual({ kind: 'idle' });
    // The refresh moved the account's version, and the writer's bytes went on top of it once rather than asking the same question.
    expect(seen).toEqual([{ removed: [], assets: { files: { 'assets/c_2K4Q9WJ1TT.png': mine }, removed: [] } }]);
  });
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

  it('sends the picture this device changed, and leaves the ones it did not', async () => {
    const seen: { assets?: { files: Record<string, Uint8Array> } }[] = [];
    const saving = target(async (_state, options) => {
      seen.push(options as never);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    });
    const untouched = new Uint8Array([7]);
    const before = new Uint8Array([8]);
    const files = { 'assets/c_2K4Q9WJ1TT.png': untouched, 'assets/c_5RB7XQ2MNN.png': new Uint8Array([9]) };
    saving.attach({ ...session(state()), assets: async () => files });
    const project = state();
    await saving.rememberOpened(project.documents.keys(), { 'assets/c_2K4Q9WJ1TT.png': untouched, 'assets/c_5RB7XQ2MNN.png': before });
    await saving.save(project);
    // The cover is the account's own bytes as this device opened them, so it is not sent again; the picture the writer changed is.
    expect(seen).toEqual([{ removed: [], assets: { files: { 'assets/c_5RB7XQ2MNN.png': new Uint8Array([9]) }, removed: [] } }]);
  });

  it('does not write this browser’s older picture over another device’s newer one', async () => {
    const seen: { assets?: { files: Record<string, Uint8Array> } }[] = [];
    // The account's version of the cover moved past the one this device opened at: another device wrote it.
    const saving = target(async (_state, options) => {
      seen.push(options as never);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    }, { 'assets/c_2K4Q9WJ1TT.png': 4 });
    const mine = new Uint8Array([7]);
    saving.attach({ ...session(state()), assets: async () => ({ 'assets/c_2K4Q9WJ1TT.png': mine }) });
    const project = state();
    await saving.rememberOpened(project.documents.keys(), { 'assets/c_2K4Q9WJ1TT.png': mine });
    // As it opened, with the adapter's version of the cover already behind the account's: the baseline records what it read.
    await saving.save(project);
    expect(seen).toEqual([{ removed: [], assets: { files: {}, removed: [] } }]);
  });

  it('asks about a picture this device changed while another device changed it too', async () => {
    const seen: unknown[] = [];
    const queue = holdingQueue();
    // The cover's version on the account, as the adapter holds it: 1 when this device read it, 2 after another device wrote it.
    let coverVersion = 1;
    const saving = new HostedTarget('p_lighthouse', { versionOf: (path: string) => (path === 'assets/c_2K4Q9WJ1TT.png' ? coverVersion : 0) } as never,
      (async (_state, options) => { seen.push(options); return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }; }) as never,
      queue.port);
    const asOpened = new Uint8Array([1]);
    const changed = new Uint8Array([2]);
    saving.attach({ ...session(state()), assets: async () => ({ 'assets/c_2K4Q9WJ1TT.png': changed }) });
    const project = state();
    await saving.rememberOpened(project.documents.keys(), { 'assets/c_2K4Q9WJ1TT.png': asOpened });
    coverVersion = 2;
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['assets/c_2K4Q9WJ1TT.png'] });
    expect(seen).toEqual([]);
    expect(queue.held()).toEqual(['assets/c_2K4Q9WJ1TT.png']);
  });

  it('names the documents and pictures this device deleted since it opened', async () => {
    const seen: unknown[] = [];
    const saving = target(async (_state, options) => {
      seen.push(options);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    });
    const project = state();
    saving.attach({ ...session(project), assets: async () => ({}) });
    await saving.rememberOpened(['n_old', ...project.documents.keys()], { 'assets/c_2K4Q9WJ1TT.png': new Uint8Array([9]) });
    await saving.save(project);
    expect(seen).toEqual([{ removed: ['n_old'], assets: { files: {}, removed: ['assets/c_2K4Q9WJ1TT.png'] } }]);
  });

  it('forgets what the account holds once a save lands, so the next deletion is measured against it', async () => {
    const seen: unknown[] = [];
    const saving = target(async (_state, options) => {
      seen.push(options);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    });
    const project = state();
    saving.attach({ ...session(project), assets: async () => ({}) });
    await saving.rememberOpened(['n_old'], {});
    await saving.save(project);
    await saving.save(project);
    expect(seen).toEqual([
      { removed: ['n_old'], assets: { files: {}, removed: [] } },
      { removed: [], assets: { files: {}, removed: [] } },
    ]);
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
    forget: (paths) => {
      calls.push(`forget:${paths === undefined ? 'all' : paths.join(',')}`);
      if (paths === undefined) held.clear();
      else for (const path of paths) held.delete(path);
    },
    rebase: (paths) => calls.push(`rebase:${paths.join(',')}`),
    held: () => [...held],
    marks: () => calls.push('marks'),
  };
  return { port, calls, held };
}

function withQueue(port: HostedQueuePort, save: (state: ProjectState) => Promise<unknown>): HostedTarget {
  // The adapter under these tests is a stand-in: it reads as version 0 for every path, which is what a picture the account has never
  // seen looks like.
  return new HostedTarget('p_lighthouse', { refresh: async () => undefined, versionOf: () => 0 } as never, save as never, port);
}

describe('the queue a hosted project keeps on this device', () => {
  it('leaves what a replay did not settle to the queue, so an edit staged while it was on its way stays', async () => {
    // The queue settles a replay itself, and only where a path still holds exactly the bytes it sent: an edit staged during the commit
    // is newer than what landed. The target must not forget by path, which would drop it and still report the save as landed.
    const one = queue(['docs/a.md'], () => ({ kind: 'sent', count: 1 }));
    const saving = withQueue(one.port, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never);
    await saving.replayHeld();
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(one.calls.filter((call) => call.startsWith('forget'))).toEqual([]);
  });

  it('answers only for the paths the writer was shown, so a path they never saw still asks', async () => {
    const one = queue(['docs/a.md', 'docs/b.md'], () => ({ kind: 'conflict', paths: ['docs/a.md'] }));
    const saving = withQueue(one.port, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never);
    await saving.replayHeld();
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    await saving.keepMine();
    // The shown path is rebased; the second one keeps the version it was held against, so a replay that finds it moved still asks.
    expect(one.calls).toContain('rebase:docs/a.md');
    expect(one.calls).not.toContain('rebase:docs/a.md,docs/b.md');
  });

  it('does not ask for a re-read when the answer did not reach the account', async () => {
    const one = queue(['docs/a.md'], () => ({ kind: 'conflict', paths: ['docs/a.md'] }));
    const saving = withQueue(one.port, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never);
    await saving.replayHeld();
    // The replay refuses again: the queue is still the newest copy, so the book in front of the writer must not be replaced by it.
    expect(await saving.keepMine()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(saving.rereadNeeded).toBe(false);
  });

  it('settles a picture it carried, so the account does not offer it as a conflict against itself', async () => {
    const one = queue(['assets/c_2K4Q9WJ1TT.png']);
    const saving = withQueue(one.port, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never);
    const project = state();
    saving.attach({ ...session(project), assets: async () => ({ 'assets/c_2K4Q9WJ1TT.png': new Uint8Array([5]) }) });
    await saving.rememberOpened(project.documents.keys(), {});
    await saving.save(project);
    // The picture was staged outside the report, and it is still what the queue held: a save that carried it settles it.
    expect(one.calls).toContain(`forget:assets/c_2K4Q9WJ1TT.png`);
  });

  it('sends the queue from a retry while the writer’s answer has not landed, and asks for a re-read once it has', async () => {
    const answers = [
      { kind: 'conflict' as const, paths: ['docs/a.md'] },
      { kind: 'unavailable' as const, changes: [] },
      { kind: 'sent' as const, count: 1 },
    ];
    const one = queue(['docs/a.md'], () => answers.shift() ?? { kind: 'sent', count: 1 });
    const saves: unknown[] = [];
    const saving = withQueue(one.port, (async (current: ProjectState) => {
      saves.push(current);
      return { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } };
    }) as never);
    await saving.replayHeld();
    await saving.keepMine();
    // The answer did not reach the account: an ordinary save must send the queue, not write this session's older state.
    expect(saving.state()).toEqual({ kind: 'unsaved' });
    expect(saving.rereadNeeded).toBe(false);
    await saving.save(state());
    expect(saves).toEqual([]);
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(saving.rereadNeeded).toBe(true);
    // Once it landed, the next save is an ordinary one again.
    await saving.save(state());
    expect(saves.length).toBe(1);
  });

  it('replays the paths the writer just answered for, measured against the version the refresh read', async () => {
    const one = queue(['docs/a.md'], () => ({ kind: 'conflict', paths: ['docs/a.md'] }));
    const saving = withQueue(one.port, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never);
    await saving.replayHeld();
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    await saving.keepMine();
    // The answer rebases the held paths to the version the refresh just read before replaying, or the same refusal would come back.
    expect(one.calls).toContain('rebase:docs/a.md');
    expect(one.calls.filter((call) => call === 'replay').length).toBe(2);
  });

  it('holds what the server did not take, so a reload sends it instead of losing it', async () => {
    const held = queue([]);
    const saving = withQueue(held.port, async () => ({ kind: 'unavailable', changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] }));
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
    expect(held.calls).toEqual(['hold:docs/a.md']);
    expect(held.port.held()).toEqual(['docs/a.md']);
  });

  it('forgets only the paths the save carried, and keeps what it did not touch queued', async () => {
    const kept = queue(['docs/old.md', 'docs/written.md']);
    const saving = withQueue(kept.port, async () => ({
      kind: 'written',
      report: { written: ['docs/written.md'], rotated: [], dropped: [], pruned: [] },
    }));
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(kept.calls).toEqual(['forget:docs/written.md', 'marks']);
    expect(kept.port.held()).toEqual(['docs/old.md']);
  });

  it('replays an earlier tab’s words before the project is read, and keeps the marks after', async () => {
    const kept = queue(['docs/a.md']);
    const saving = withQueue(kept.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(await saving.replayHeld()).toEqual({ kind: 'sent', count: 1 });
    expect(saving.state()).toEqual({ kind: 'idle' });
    expect(kept.calls).toContain('marks');
  });

  it('asks when the replayed words lose to another device, keeps them queued, and replays on the answer', async () => {
    // The replay loses to another device first, then lands once the writer keeps this device's text.
    const answers = [
      { kind: 'conflict' as const, paths: ['docs/a.md'] },
      { kind: 'sent' as const, count: 1 },
    ];
    const kept = queue(['docs/a.md'], () => answers.shift() ?? { kind: 'sent', count: 1 });
    const saving = withQueue(kept.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(await saving.replayHeld()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(kept.port.held()).toEqual(['docs/a.md']);

    expect(await saving.keepMine()).toEqual({ kind: 'idle' });
    expect(saving.rereadNeeded).toBe(true);
    expect(kept.calls.filter((call) => call === 'replay').length).toBe(2);
  });

  it('does nothing at open when no earlier tab left anything', async () => {
    const empty = queue([]);
    const saving = withQueue(empty.port, async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
    expect(await saving.replayHeld()).toBeNull();
    expect(empty.calls).toEqual([]);
  });
});
