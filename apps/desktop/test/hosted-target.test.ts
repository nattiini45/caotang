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

/**
 * A queue as the adapter hands it to the target: the paths it holds, what a send answers, what it was asked to forget, and — for a store
 * that is blocked or full — whether holding anything reached it at all.
 */
function queue(
  initial: readonly string[],
  answer: HostedReplay | (() => HostedReplay) = { kind: 'sent', count: 1 },
  durable = true,
  /** The files the save carries, which the account holds once it lands. */
  carried: readonly string[] = [],
) {
  const held = new Set(initial);
  const calls: string[] = [];
  const port: HostedQueuePort = {
    hold: (changes) => {
      calls.push(`hold:${changes.map((change) => change.path).join(',')}`);
      // The queue holds the words either way; `durable` is only whether they also reached this device's storage.
      for (const change of changes) held.add(change.path);
      return durable;
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
    settle: async (removed) => {
      // The account now holds what this save carried, so a held path whose words those are is settled; anything else is still this
      // device's to send.
      const settled = [...held].filter((path) => carried.includes(path) || removed.some((id) => path === `docs/${id}.md`));
      calls.push(`settle:${settled.join(',')}`);
      for (const path of settled) held.delete(path);
      return held.size > 0;
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
  refresh: () => Promise<void> = async () => undefined,
) {
  const saves: unknown[] = [];
  /** What the staging was asked for: the deletions and pictures a save carried, and nothing else. */
  const stagedCalls: unknown[] = [];
  const last = (): Answer => answers.length > 1 ? answers.shift()! : answers[0]!;
  const saving = new HostedTarget('p_lighthouse', {
    refresh,
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
  }) as never, port, async (_state: unknown, options: unknown) => {
    stagedCalls.push(options);
    const asked = options as { removed?: readonly string[]; assets?: { files?: Readonly<Record<string, Uint8Array>>; removed?: readonly string[] } } | undefined;
    // The staged save as the app builds it: the project's files, the documents it deleted under the names the account holds them by, and
    // the pictures that travel with them. Nothing here reads the account, which is the point of staging rather than trusting the attempt.
    return [
      ...staged.map((path) => ({ path, bytes: new Uint8Array([1]) })),
      ...(asked?.removed ?? []).map((id) => ({ path: `docs/${id}.md`, bytes: null })),
      ...Object.keys(asked?.assets?.files ?? {}).map((path) => ({ path, bytes: new Uint8Array([1]) })),
      ...(asked?.assets?.removed ?? []).map((path) => ({ path, bytes: null })),
    ];
  });
  return { saving, saves, stagedCalls };
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
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
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
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
    expect(one.calls.filter((call) => call === 'send')).toEqual([]);
  });

  it('a save that failed after staging the words holds them in the queue instead of losing them', async () => {
    const one = queue([]);
    const { saving } = target([{ kind: 'failed', changes: ['docs/a.md'] }], one.port);
    await saving.save(state());
    // The words the account never took are this device's, so they are queued and named; nothing is sent on its own.
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
    expect(one.calls).toEqual(['hold:docs/a.md']);
    expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
    expect(one.calls.filter((call) => call === 'send').length).toBe(1);
  });

  it('a save the account did not take holds the words it would have written, not the half-save it stopped in', async () => {
    // A save stops where it could not read or write, so the overlay the attempt left behind can be half a save: the documents of a
    // manifest that never landed, a deletion the write path never reached, a picture never staged. Queueing that would tell the writer
    // their work is safe while the account keeps a project the queue can only partly restore, so the held words are staged here instead.
    const one = queue([]);
    const { saving, stagedCalls } = target([{ kind: 'unavailable', changes: ['docs/a.md'] }], one.port, {}, ['docs/a.md', 'caotang.json']);
    // A document this device held when it opened the project, and the state it is saving no longer has.
    saving.rememberOpened(['n_GONE'], {});
    await saving.save(state());
    expect(one.port.held()).toEqual(['docs/a.md', 'caotang.json', 'docs/n_GONE.md']);
    expect(saving.state()).toEqual({
      kind: 'unsaved',
      paths: ['docs/a.md', 'caotang.json', 'docs/n_GONE.md'],
      persisted: true,
    });
    // The staging was told what this device deleted, so it can name the file without asking the account.
    expect(stagedCalls).toEqual([{ removed: ['n_GONE'], assets: undefined }]);
  });

  it('a queue that could not be written says the words are in this tab only', async () => {
    // A blocked or full store takes nothing, and saying "on this device" would be the one sentence that costs the writer their work.
    const one = queue([], { kind: 'sent', count: 1 }, false);
    const { saving } = target([{ kind: 'unavailable' }], one.port);
    await saving.save(state());
    // The queue holds the words; what it could not do is put them where a reload reads them.
    expect(one.port.held()).toEqual(['docs/a.md']);
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: false });
  });

  it('a send that fails keeps the tab-only answer it started with', async () => {
    // The queue could not be written, so the words are in this tab only. A send that then fails must not upgrade that answer: nothing new
    // reached storage, and telling the writer the copy is safe is the sentence that costs them the work.
    const one = queue([], { kind: 'sent', count: 1 }, false);
    const { saving } = target([{ kind: 'unavailable' }, { kind: 'written' }], one.port, {}, ['docs/a.md'], async () => {
      throw new Error('offline');
    });
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: false });
    // The send fails at the refresh, and the answer is still the one the queue gave: nothing reached storage, then or now.
    expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: false });
    expect(one.calls.filter((call) => call === 'send')).toEqual([]);
  });

  it('a path another device moved goes into the queue and is asked about, with nothing written', async () => {
    const one = queue([]);
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }], one.port);
    await saving.save(state());
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });
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
    expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
    expect(one.port.held()).toEqual(['docs/a.md']);
  });

  it('a send another device beat asks the question instead', async () => {
    const one = queue(['docs/a.md'], { kind: 'conflict', paths: ['docs/a.md'], persisted: true });
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    expect(await saving.sendQueued()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });
  });

  it('a browser save commits the whole state, which supersedes the queued paths it carries', async () => {
    const one = queue(['docs/a.md']);
    const { saving, saves } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    await saving.save(state());
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a save settles the words the account now holds and keeps the ones it never carried', async () => {
    // A queued edit is its own text: an open takes the account's version and adopts nothing, so the session may never have held it. A save
    // therefore settles what the account now holds — the files it carried and the documents it deleted — and leaves the rest queued for the
    // writer to send, because throwing it away would be the one loss nothing can undo (hosted.md §7.2).
    const one = queue(['docs/a.md', 'caotang.json', 'docs/b.md', 'docs/n_GONE.md'], undefined, true, ['docs/a.md', 'caotang.json']);
    const { saving } = target([{ kind: 'written', written: ['docs/a.md', 'caotang.json'] }], one.port);
    saving.heldAtOpen();
    await saving.save(state());
    expect(one.calls).toContain('settle:docs/a.md,caotang.json');
    expect(one.port.held()).toEqual(['docs/b.md', 'docs/n_GONE.md']);
  });

  it('settles a queued edit of a document this save deleted', async () => {
    // The writer removed the scene, so words for its file are not words the account is missing.
    const one = queue(['docs/n_GONE.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    saving.rememberOpened(['n_GONE'], {});
    await saving.save(state());
    expect(one.port.held()).toEqual([]);
  });

  it('a send against an account that is still unreachable keeps the words and the action', async () => {
    // The writer clicks send with the connection still down: the refresh is what fails, and it fails before anything was sent. A state
    // left at `saving` would hide itself from the notice and refuse every later send, so the words stay held and the action stays there.
    let reachable = false;
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port, {}, ['docs/a.md'], async () => {
      if (!reachable) throw new Error('offline');
    });
    saving.heldAtOpen();
    expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
    expect(one.calls.filter((call) => call === 'send')).toEqual([]);
    reachable = true;
    expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
    expect(one.calls.filter((call) => call === 'send').length).toBe(1);
  });

  it('a send with nothing held says the words are in this tab only instead of reopening the session', async () => {
    // Nothing held is nothing to send, and it is also nothing the account will get: a state of idle would claim the account has words it
    // never received, and the only true thing left to say is that they are here and the writer has to keep them.
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.heldAtOpen();
    one.port.forget(['docs/a.md']);
    expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: [], persisted: false });
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
      hold: () => true,
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
      settle: async () => held.size > 0,
    };
    const { saving, saves } = target([{ kind: 'written' }], port);
    saving.heldAtOpen();
    expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });

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
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'], persisted: true }, { kind: 'written' }]);
    const project = state();
    await saving.save(project);
    // No queue is attached, so nothing could be kept beyond this tab and the state says so.
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: false });
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
    expect(await saving.keepMine()).toEqual({ kind: 'unsaved', paths: ['docs/a.md'], persisted: true });
    expect(saving.rereadNeeded).toBe(false);
  });

  it('a save the browser finished is refused while the question is up', async () => {
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }]);
    const project = state();
    await saving.save(project);
    const before = saves.length;
    await saving.save(project);
    expect(saves.length).toBe(before);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: false });
  });

  it('a save made while the question stands is held even when the account cannot be read, and writes nothing', async () => {
    // "Leave it for now" leaves the writer working: those saves are refused to the account, and their words go to the queue, because
    // the account's version takes this browser's copy over at the next open.
    const one = queue([]);
    // The staging carries the whole project, so both documents are what this device holds.
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }], one.port, {}, ['docs/a.md', 'docs/b.md']);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });

    await saving.save(state());
    expect(saves.length).toBe(1);
    // The refused path is still there from the question, and the words written since join it. The held words are built without reading
    // the account, so a question waiting to be answered cannot cost the writer what they typed.
    expect(one.port.held()).toEqual(['docs/a.md', 'docs/b.md']);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });
  });

  it('leaving it changes nothing and sends nothing', async () => {
    const one = queue(['docs/a.md']);
    const { saving } = target([{ kind: 'written' }], one.port);
    saving.raiseConflict(['docs/a.md']);
    expect(one.calls).toEqual([]);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });
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
    expect(await saving.sendQueued()).toEqual({ kind: 'conflict', paths: ['docs/a.md'], persisted: true });
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
    const { saving, saves } = target([{ kind: 'conflict', paths: [COVER] }], one.port, {}, []);
    const project = state();
    saving.attach({ ...session(project).session, assets: async () => ({ [COVER]: new Uint8Array([2]) }) });
    saving.rememberOpened(project.documents.keys(), { [COVER]: new Uint8Array([1]) });
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: [COVER], persisted: true });
    expect(saves.length).toBe(1);
    expect(one.port.held()).toEqual([COVER]);
  });

  it('settles the pictures it carried, so the account does not offer them back as a conflict', async () => {
    const one = queue([COVER], undefined, true, [COVER]);
    const { saving } = target([{ kind: 'written' }], one.port);
    const project = state();
    saving.attach({ ...session(project).session, assets: async () => ({ [COVER]: new Uint8Array([5]) }) });
    saving.rememberOpened(project.documents.keys(), {});
    await saving.save(project);
    // The save carried the picture, so the account holds it and the queued copy is settled: it is not offered back as a conflict.
    expect(one.port.held()).toEqual([]);
  });
});
