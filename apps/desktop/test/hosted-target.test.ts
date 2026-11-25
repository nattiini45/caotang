/**
 * The account as a session's save target (hosted.md §7.2). One test per row of the state table: the states, the events that move
 * between them, and the events that a state refuses. What the table promises in prose, these tests pin as behaviour — including that
 * nothing is sent to the account unless a writer asked for it.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { HostedTarget, type HostedQueuePort, type HostedReplay, type HostedSaveSession } from '../src/app/hosted-target.js';

const T0 = new Date('2026-11-24T09:00:00.000Z');
const COVER = 'assets/c_2K4Q9WJ1TT.png';

function state(): ProjectState {
  return createProjectState(createEmptyManifest('The Lighthouse', T0));
}

/** A session as the target uses it: the state, and the browser save's own signal. */
function session(current: ProjectState) {
  const listeners = new Set<() => void>();
  let status = 'idle';
  return {
    session: {
      state: current,
      persistence: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getStatus: () => status,
      },
    } as HostedSaveSession,
    /** The browser's own save, as `persistence-model.ts` reports it: `writing` on the way, `idle` when it landed. */
    saved(): void {
      status = 'writing';
      for (const listener of listeners) listener();
      status = 'idle';
      for (const listener of listeners) listener();
    },
  };
}

/** A queue as the adapter hands it to the target: the paths it holds, what a send answers, and what it was asked to forget. */
function queue(initial: readonly string[], answer: HostedReplay | (() => HostedReplay) = { kind: 'sent', count: 1 }) {
  const held = new Set(initial);
  const calls: string[] = [];
  const port: HostedQueuePort = {
    hold: (changes) => {
      calls.push(`hold:${changes.map((change) => change.path).join(',')}`);
      for (const change of changes) held.add(change.path);
    },
    replay: async () => {
      calls.push('send');
      const outcome = typeof answer === 'function' ? answer() : answer;
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

type Answer =
  | { kind: 'written'; written?: string[]; pruned?: string[] }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'unavailable'; changes?: string[] }
  | { kind: 'failed'; changes: string[] }
  | { kind: 'throw' };

/** A target whose account save answers from a list, the last answer repeating. */
function target(
  answers: Answer[] = [{ kind: 'written' }],
  port: HostedQueuePort | null = null,
  versions: Record<string, number> = {},
  staged: readonly string[] = ['docs/a.md'],
) {
  const saves: unknown[] = [];
  const last = (): Answer => answers.length > 1 ? answers.shift()! : answers[0]!;
  const saving = new HostedTarget('p_lighthouse', {
    refresh: async () => undefined,
    commitChanges: async () => undefined,
    versionOf: (path: string) => versions[path] ?? 0,
  } as never, (async (_state: unknown, options: unknown) => {
    saves.push(options);
    const answer = last();
    if (answer.kind === 'throw') throw new Error('refused');
    if (answer.kind === 'written') return { kind: 'written', report: { written: answer.written ?? [], rotated: [], dropped: [], pruned: answer.pruned ?? [] } };
    if (answer.kind === 'conflict') return { kind: 'conflict', paths: answer.paths, changes: answer.paths.map((path) => ({ path, bytes: new Uint8Array([1]) })) };
    const changes = (answer.kind === 'failed' ? answer.changes : answer.changes ?? []).map((path) => ({ path, bytes: new Uint8Array([1]) }));
    if (answer.kind === 'failed') return { kind: 'failed', error: new Error('refused'), changes };
    return { kind: 'unavailable', changes };
  }) as never, port, async () => staged.map((path) => ({ path, bytes: new Uint8Array([1]) })));
  return { saving, saves };
}

describe('idle', () => {
  it('a save the browser finished commits to the account and comes back to idle', async () => {
    const { saving, saves } = target();
    const project = state();
    const owner = session(project);
    saving.attach(owner.session);
    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('commits on the browser save landing, not on every status it passes through', async () => {
    // The status a landed save leaves behind is `idle`; there is no `saved`. A subscription that waited for one would never commit, and
    // one that fired on every change would commit twice for one save.
    const { saving, saves } = target();
    const project = state();
    const owner = session(project);
    saving.attach(owner.session);
    owner.saved();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves.length).toBe(1);
  });

  it('an open that finds words in the queue says they are here, and sends nothing', async () => {
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'] });
    expect(one.calls).toEqual([]);
  });
});

describe('saving', () => {
  it('a commit the server took comes back to idle', async () => {
    const { saving } = target([{ kind: 'written' }]);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a server that did not answer leaves the words in the queue as unsaved', async () => {
    const one = queue([]);
    const { saving } = target([{ kind: 'unavailable' }], one.port);
    await saving.save(state());
    // Nothing is sent on its own: the state says these words are here, and the writer decides when the account gets them.
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: [] });
    expect(one.calls.filter((call) => call === 'send')).toEqual([]);
  });

  it('a save that failed after staging the words holds them in the queue instead of losing them', async () => {
    const one = queue([]);
    const { saving } = target([{ kind: 'failed', changes: ['docs/a.md'] }], one.port);
    await saving.save(state());
    // The words the account never took are this device's, so they are queued and named; nothing is sent on its own.
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'] });
    expect(one.calls).toEqual(['hold:docs/a.md']);
    expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
    expect(one.calls.filter((call) => call === 'send').length).toBe(1);
  });

  it('a path another device moved goes into the queue and is asked about, with nothing written', async () => {
    const one = queue([]);
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }], one.port);
    await saving.save(state());
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });
});

describe('unsaved', () => {
  it('the writer sends them, and landing leaves the session stale', async () => {
    const one = queue(['docs/a.md'], { kind: 'sent', count: 1 });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
    expect(saving.rereadNeeded).toBe(true);
    expect(one.calls).toContain('send');
  });

  it('a send the server did not take changes nothing', async () => {
    const one = queue(['docs/a.md'], { kind: 'unavailable' });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'] });
    expect(one.port.held()).toEqual(['docs/a.md']);
  });

  it('a send another device beat asks the question instead', async () => {
    const one = queue(['docs/a.md'], { kind: 'conflict', paths: ['docs/a.md'] });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    expect(await saving.sendQueued()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });

  it('a browser save commits the whole state, which supersedes the queued paths it carries', async () => {
    const one = queue(['docs/a.md']);
    const { saving, saves } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    await saving.save(state());
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a save forgets every document path it wrote or pruned, not only the pictures it sent', async () => {
    // A queued edit of a file this save wrote is older than what landed, and leaving it queued would let the next send put that older
    // text back over the account's (hosted.md §7.2). A path the save did not carry is somebody else's and stays queued.
    const one = queue(['docs/a.md', 'caotang.json', 'codex/x.md', 'docs/b.md']);
    const { saving } = target([{ kind: 'written', written: ['docs/a.md', 'caotang.json'], pruned: ['codex/x.md'] }], one.port);
    saving.heldAtOpen();
    await saving.save(state());
    expect(one.port.held()).toEqual(['docs/b.md']);
  });

  it('a send with nothing held goes back to idle instead of reopening the session for words that never left', async () => {
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    one.port.forget(['docs/a.md']);
    expect(await saving.sendQueued()).toEqual({ kind: 'idle' });
    expect(one.calls.filter((call) => call === 'send')).toEqual([]);
    expect(saving.rereadNeeded).toBe(false);
  });
});

describe('one write at a time', () => {
  it('a browser save that lands during a send waits for it, and does not commit the older book over it', async () => {
    // The writer's send is on its way when a save the browser finished arrives. The save must not commit the state read before the
    // send: chained behind it, it finds the session stale and writes nothing.
    let finish: (() => void) | null = null;
    const held = new Set(['docs/a.md']);
    const calls: string[] = [];
    const port = {
      hold: () => undefined,
      replay: async () => {
        calls.push('send');
        await new Promise<void>((resolve) => { finish = resolve; });
        held.clear();
        return { kind: 'sent', count: 1 } as const;
      },
      forget: () => undefined,
      rebase: () => undefined,
      held: () => [...held],
      marks: () => undefined,
    };
    const { saving, saves } = target([{ kind: 'written' }], port);
    saving.heldAtOpen();
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'] });

    const sending = saving.sendQueued();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writing = saving.save(state());
    finish!();
    await Promise.all([sending, writing]);

    expect(calls).toEqual(['send']);
    expect(saves.length).toBe(0);
    expect(saving.state()).toEqual({ kind: 'stale' });
  });
});

describe('conflict', () => {
  it('keeping this device’s text saves the state it read on top of the other device’s version', async () => {
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }, { kind: 'written' }]);
    const project = state();
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(await saving.keepMine(project)).toEqual({ kind: 'idle' });
    expect(saves.length).toBe(2);
    // This session's own state was the answer, so the book in front of the writer is already what the account now holds.
    expect(saving.rereadNeeded).toBe(false);
  });

  it('keeping this device’s text for a queued conflict rebases only the shown paths, then sends them', async () => {
    const one = queue(['docs/a.md', 'docs/b.md'], { kind: 'sent', count: 1 });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.raiseConflict(['docs/a.md']);
    expect(await saving.keepMine()).toEqual({ kind: 'stale' });
    expect(one.calls.filter((call) => call.startsWith('rebase'))).toEqual(['rebase:docs/a.md']);
    expect(saving.rereadNeeded).toBe(true);
  });

  it('an answer the server did not take keeps the question', async () => {
    const one = queue(['docs/a.md'], { kind: 'unavailable' });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.raiseConflict(['docs/a.md']);
    expect(await saving.keepMine()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'] });
    expect(saving.rereadNeeded).toBe(false);
  });

  it('a save the browser finished is refused while the question is up', async () => {
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }]);
    const project = state();
    await saving.save(project);
    const before = saves.length;
    await saving.save(project);
    expect(saves.length).toBe(before);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });

  it('a save made while the question stands is held even when the account cannot be read, and writes nothing', async () => {
    // "Leave it for now" leaves the writer working: those saves are refused to the account, and their words go to the queue, because
    // the account's version takes this browser's copy over at the next open.
    const one = queue([]);
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }], one.port, {}, ['docs/b.md']);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });

    await saving.save(state());
    expect(saves.length).toBe(1);
    // The refused path is still there from the question, and the words written since join it. The held words are built without reading
    // the account, so a question waiting to be answered cannot cost the writer what they typed.
    expect(one.port.held()).toEqual(['docs/a.md', 'docs/b.md']);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });

  it('leaving it changes nothing and sends nothing', async () => {
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.raiseConflict(['docs/a.md']);
    expect(one.calls).toEqual([]);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });
});

describe('stale', () => {
  it('opening the project again clears it', async () => {
    const one = queue(['docs/a.md'], { kind: 'sent', count: 1 });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    await saving.sendQueued();
    expect(saving.state()).toEqual({ kind: 'stale' });
    // The session catching up is what a fresh open does.
    saving.rememberOpened(state().documents.keys(), {});
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a save from here writes nothing: the older book would go over what the send just put there', async () => {
    const one = queue(['docs/a.md'], { kind: 'sent', count: 1 });
    const { saving, saves } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    await saving.sendQueued();
    await saving.save(state());
    expect(saves).toEqual([]);
    expect(saving.state()).toEqual({ kind: 'stale' });
  });

  it('a send or a question from here is refused', async () => {
    const one = queue(['docs/a.md'], { kind: 'sent', count: 1 });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    await saving.sendQueued();
    expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
    saving.raiseConflict(['docs/a.md']);
    expect(saving.state()).toEqual({ kind: 'stale' });
  });
});

describe('events a state refuses', () => {
  it('sending from idle or a question sends nothing', async () => {
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    expect(await saving.sendQueued()).toEqual({ kind: 'idle' });
    saving.raiseConflict(['docs/a.md']);
    expect(await saving.sendQueued()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(one.calls).toEqual([]);
  });

  it('answering when there is no question changes nothing', async () => {
    const { saving, saves } = target([{ kind: 'written' }]);
    expect(await saving.keepMine(state())).toEqual({ kind: 'idle' });
    expect(await saving.keepMine()).toEqual({ kind: 'idle' });
    expect(saves).toEqual([]);
  });

  it('asking a question while a commit is in flight is refused', async () => {
    const { saving } = target([{ kind: 'written' }]);
    const savingNow = saving.save(state());
    saving.raiseConflict(['docs/a.md']);
    expect(saving.state()).toEqual({ kind: 'saving' });
    await savingNow;
    expect(saving.state()).toEqual({ kind: 'idle' });
  });
});

describe('what a save carries', () => {
  it('carries every picture the session holds, and the ones it deleted while the session was open', async () => {
    // Pictures are files like any other: the save carries what the session has, names what it deleted, and the adapter's own version
    // check is what refuses a picture another device moved. Nothing here treats a picture differently from a document.
    const { saving, saves } = target([{ kind: 'written' }]);
    const project = state();
    const held = { [COVER]: new Uint8Array([7]), 'assets/c_5RB7XQ2MNN.png': new Uint8Array([9]) };
    saving.attach({ ...session(project).session, assets: async () => held });
    saving.rememberOpened(project.documents.keys(), { ...held, 'assets/c_GONE.png': new Uint8Array([3]) });
    await saving.save(project);
    expect(saves).toEqual([{ removed: [], assets: { files: held, removed: ['assets/c_GONE.png'] } }]);
  });

  it('asks about a picture another device moved, with the same question a document gets', async () => {
    const one = queue([]);
    const { saving, saves } = target([{ kind: 'conflict', paths: [COVER] }], one.port);
    const project = state();
    saving.attach({ ...session(project).session, assets: async () => ({ [COVER]: new Uint8Array([2]) }) });
    saving.rememberOpened(project.documents.keys(), { [COVER]: new Uint8Array([1]) });
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: [COVER] });
    expect(saves.length).toBe(1);
    expect(one.port.held()).toEqual([COVER]);
  });

  it('settles the pictures it carried, so the account does not offer them back as a conflict', async () => {
    const one = queue([COVER]);
    const { saving } = target([{ kind: 'written' }], one.port);
    const project = state();
    saving.attach({ ...session(project).session, assets: async () => ({ [COVER]: new Uint8Array([5]) }) });
    saving.rememberOpened(project.documents.keys(), {});
    await saving.save(project);
    expect(one.calls).toContain(`forget:${COVER}`);
  });
});
