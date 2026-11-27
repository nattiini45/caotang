import { expect, it, vi } from 'vitest';
import { createEmptyManifest, createProjectState } from '@caotang/store';
import { HostedTarget, type HostedQueuePort, type HostedReplay, type HostedSaveSession } from '../src/app/hosted-target.js';

const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
const path = 'docs/a.md';
const change = { path, bytes: new Uint8Array([1]), base: 1, version: 2, represented: true };
const conflict: HostedReplay = { kind: 'conflict', versions: new Map([[path, 2]]) };

async function target(pending: readonly string[] = [], durable = true) {
  const held = new Set(pending);
  const deferred = new Set<string>();
  const send = vi.fn<HostedQueuePort['send']>(async () => ({ kind: 'accepted', changes: [change] }));
  const queue: HostedQueuePort = {
    held: () => [...held],
    deferred: () => [...deferred],
    opened: () => undefined,
    persisted: () => durable,
    stage: (changes, unread) => {
      for (const one of changes) (unread?.has(one.path) ? deferred : held).add(one.path);
    },
    send: async (...args) => {
      const result = await send(...args);
      if (result.kind === 'accepted') held.clear();
      return result;
    },
  };
  const accepted = vi.fn();
  const changes = vi.fn(async () => [change]);
  const saving = new HostedTarget('p_lighthouse', {} as never, queue, async () => ({
    prepare: async () => ({ changes: await changes(), staged: () => undefined }),
    accepted,
  }));
  await saving.rememberOpened(state, {});
  return { saving, accepted, changes, send };
}

it('commits on the browser save landing, not on every status it passes through', async () => {
  const { saving, send, accepted } = await target();
  let listener: () => void = () => undefined;
  let status: ReturnType<HostedSaveSession['persistence']['getStatus']> = 'idle';
  saving.attach({
    state,
    assets: async () => ({}),
    persistence: {
      subscribe: (next) => { listener = next; return () => {}; },
      getStatus: () => status,
    },
  });
  for (status of ['idle', 'writing', 'failed', 'idle', 'writing', 'idle', 'idle'] as const) listener();
  await saving.settled();
  expect(send).toHaveBeenCalledExactlyOnceWith(false, undefined);
  expect(accepted).toHaveBeenCalledExactlyOnceWith([change]);
  expect(saving.state()).toEqual({ kind: 'idle' });
});

it('a no-op save does not write anything', async () => {
  const { saving, send, changes } = await target();
  changes.mockResolvedValueOnce([]);
  await saving.save(state);
  expect(send).not.toHaveBeenCalled();
});

it('does not report the account saved while it is preparing the files', async () => {
  const { saving, changes, send } = await target();
  let prepared: (value: typeof change[]) => void = () => undefined;
  changes.mockImplementationOnce(() => new Promise((resolve) => { prepared = resolve; }));
  const writing = saving.save(state);
  await vi.waitFor(() => expect(changes).toHaveBeenCalledOnce());
  expect(saving.state()).toEqual({ kind: 'saving' });
  expect(send).not.toHaveBeenCalled();
  prepared([change]);
  await writing;
  expect(saving.state()).toEqual({ kind: 'idle' });
});

it('an open that finds a queue offers send; a later save stages work without sending it', async () => {
  const { saving, send } = await target(['docs/earlier.md']);
  expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/earlier.md'], persisted: true });
  await saving.save(state);
  expect(saving.state()).toEqual({ kind: 'unsaved', paths: ['docs/earlier.md', path], persisted: true });
  expect(send).not.toHaveBeenCalled();
  expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
  expect(send).toHaveBeenCalledExactlyOnceWith(true, undefined);
});

it('a send that cannot refresh keeps an in-memory batch and its action available', async () => {
  const { saving, send } = await target([], false);
  send.mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValueOnce({ kind: 'unavailable' });
  await saving.save(state);
  expect(saving.state()).toEqual({ kind: 'unsaved', paths: [path], persisted: false });
  expect(await saving.sendQueued()).toEqual({ kind: 'unsaved', paths: [path], persisted: false });
  expect(await saving.sendQueued()).toEqual({ kind: 'stale' });
});

it('keeps the question if refreshing an answer fails, and holds subsequent local saves', async () => {
  const { saving, send } = await target();
  send.mockResolvedValueOnce(conflict).mockResolvedValueOnce({ kind: 'unavailable' });
  await saving.save(state);
  const asked = { kind: 'conflict', paths: [path], persisted: true };
  expect(saving.state()).toEqual(asked);
  await saving.save(state);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await saving.sendQueued()).toEqual(asked);
  expect(await saving.keepMine()).toEqual(asked);
  expect(send).toHaveBeenLastCalledWith(true, conflict.versions);
  expect(await saving.keepMine()).toEqual({ kind: 'stale' });
});

it('honours an approval for the remaining path when a queued save shrinks the question', async () => {
  const other = 'docs/b.md';
  const { saving, send } = await target([path, other]);
  send.mockResolvedValueOnce({ kind: 'conflict', versions: new Map([[path, 2], [other, 3]]) });
  expect(await saving.sendQueued()).toMatchObject({ kind: 'conflict', paths: [path, other] });
  vi.spyOn(saving.queue, 'held').mockReturnValueOnce([path]);
  const writing = saving.save(state);
  const approval = saving.keepMine();
  await writing;
  expect(await approval).toEqual({ kind: 'stale' });
  expect(send).toHaveBeenLastCalledWith(true, new Map([[path, 2]]));
});

it('does not apply an earlier approval to a new version of the same file', async () => {
  const { saving, send } = await target([path]);
  send.mockResolvedValueOnce(conflict).mockResolvedValueOnce({ kind: 'conflict', versions: new Map([[path, 3]]) });
  await saving.sendQueued();
  const first = saving.keepMine();
  const repeat = saving.keepMine();
  await first;
  expect(await repeat).toMatchObject({ kind: 'conflict', paths: [path] });
  expect(send).toHaveBeenCalledTimes(2);
  await saving.keepMine();
  expect(send).toHaveBeenLastCalledWith(true, new Map([[path, 3]]));
});

it('a new save during a send is staged after the accepted batch, without replaying the old book', async () => {
  const { saving, send, accepted } = await target([path]);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  send.mockImplementationOnce(async () => {
    await waiting;
    return { kind: 'accepted', changes: [{ ...change, represented: false }] };
  });
  const sending = saving.sendQueued();
  const writing = saving.save(state);
  finish();
  await Promise.all([sending, writing]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(accepted).not.toHaveBeenCalled();
  expect(saving.state()).toEqual({ kind: 'stale', waiting: { paths: [path], persisted: true } });
});
