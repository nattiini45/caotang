/**
 * The account as a session's save target (hosted.md §7.2). One test per row of the state table: the states, the events that move
 * between them, and the events that a state refuses. What the table promises in prose, these tests pin as behaviour — including that
 * nothing reaches the account without a browser save behind it, and that a save the account does not take says so instead of pretending.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { HostedTarget, type HostedSaveSession } from '../src/app/hosted-target.js';

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
    saved(): void {
      status = 'saved';
      for (const listener of listeners) listener();
    },
  };
}

type Answer =
  | { kind: 'written'; written?: string[]; pruned?: string[] }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | { kind: 'throw' };

/** A target whose account save answers from a list, the last answer repeating. */
function target(answers: Answer[] = [{ kind: 'written' }]) {
  const saves: unknown[] = [];
  const last = (): Answer => answers.length > 1 ? answers.shift()! : answers[0]!;
  const saving = new HostedTarget('p_lighthouse', {
    refresh: async () => undefined,
    commitChanges: async () => undefined,
  } as never, (async (_state: unknown, options: unknown) => {
    saves.push(options);
    const answer = last();
    if (answer.kind === 'throw') throw new Error('refused');
    if (answer.kind === 'written') return { kind: 'written', report: { written: answer.written ?? [], rotated: [], dropped: [], pruned: answer.pruned ?? [] } };
    if (answer.kind === 'conflict') return { kind: 'conflict', paths: answer.paths, changes: answer.paths.map((path) => ({ path, bytes: new Uint8Array([1]) })) };
    if (answer.kind === 'failed') return { kind: 'failed', error: new Error('refused'), changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] };
    return { kind: 'unavailable', changes: [{ path: 'docs/a.md', bytes: new Uint8Array([1]) }] };
  }) as never);
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
});

describe('saving', () => {
  it('a commit the account took comes back to idle', async () => {
    const { saving } = target([{ kind: 'written' }]);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a server that did not answer says the book was not saved, and keeps the words in this tab', async () => {
    const { saving } = target([{ kind: 'unavailable' }]);
    await saving.save(state());
    // Nothing is retried on its own: the notice says so, and the writer asks again.
    expect(saving.state()).toEqual({ kind: 'unsaved' });
  });

  it('a save that failed after it staged its words says the same thing, rather than nothing', async () => {
    const { saving } = target([{ kind: 'failed' }]);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
  });

  it('a save that threw before it could stage anything says so too', async () => {
    const { saving } = target([{ kind: 'throw' }]);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
  });

  it('a path another device moved stops the save and names it, with nothing written', async () => {
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }]);
    await saving.save(state());
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });
});

describe('unsaved', () => {
  it('the writer tries again, and the book as it stands is what is written', async () => {
    const { saving, saves } = target([{ kind: 'unavailable' }, { kind: 'written' }]);
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });

    await saving.save(state());
    expect(saves.length).toBe(2);
    expect(saving.state()).toEqual({ kind: 'idle' });
  });

  it('a save made after it said so is attempted again, because the browser kept writing', async () => {
    const { saving, saves } = target([{ kind: 'unavailable' }, { kind: 'unavailable' }, { kind: 'written' }]);
    await saving.save(state());
    await saving.save(state());
    expect(saving.state()).toEqual({ kind: 'unsaved' });
    await saving.save(state());
    expect(saves.length).toBe(3);
    expect(saving.state()).toEqual({ kind: 'idle' });
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
  });

  it('an answer the account did not take keeps the question', async () => {
    const { saving } = target([{ kind: 'conflict', paths: ['docs/a.md'] }, { kind: 'unavailable' }]);
    const project = state();
    await saving.save(project);
    expect(await saving.keepMine(project)).toEqual({ kind: 'unsaved' });
  });

  it('answering again with no question up changes nothing', async () => {
    const { saving, saves } = target([{ kind: 'written' }]);
    expect(await saving.keepMine(state())).toEqual({ kind: 'idle' });
    expect(saves.length).toBe(0);
  });

  it('a save the browser finished is refused while the question is up', async () => {
    const { saving, saves } = target([{ kind: 'conflict', paths: ['docs/a.md'] }]);
    const project = state();
    await saving.save(project);
    await saving.save(project);
    // One save reached the account; the second did not, because a question outranks it.
    expect(saves.length).toBe(1);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });
});

describe('what a save carries', () => {
  it('every picture the session holds, and the ones it deleted while the session was open', async () => {
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
    const { saving, saves } = target([{ kind: 'conflict', paths: [COVER] }]);
    const project = state();
    saving.attach({ ...session(project).session, assets: async () => ({ [COVER]: new Uint8Array([2]) }) });
    saving.rememberOpened(project.documents.keys(), { [COVER]: new Uint8Array([1]) });
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: [COVER] });
    expect(saves.length).toBe(1);
  });
});

describe('events a state refuses', () => {
  it('a question raised again while one is up replaces the paths the writer is shown', async () => {
    const { saving } = target([{ kind: 'conflict', paths: ['docs/a.md'] }, { kind: 'conflict', paths: ['docs/b.md'] }]);
    const project = state();
    await saving.save(project);
    await saving.save(project);
    expect(saving.state()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });
});
