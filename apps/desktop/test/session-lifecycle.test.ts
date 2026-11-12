import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore } from '@caotang/store';

import { createProject } from '../src/app/lifecycle.js';
import { acquireProjectLease } from '../src/app/project-lease.js';
import { ProjectSession } from '../src/app/session.js';
import * as coherenceIo from '../src/app/coherence-io.js';
import { pendingRows, trayOf, updateTray, forgetTray } from '../src/app/timeline-tray.js';
import { project, IDS } from '../../../e2e/unit/fixtures.js';
import { SaveChannel } from '../src/app/save-channel.js';

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: { request: (name: string, _options: unknown, callback: () => Promise<void>) => {
    if (held.has(name)) return Promise.reject(new Error('The lease is still held.'));
    held.add(name);
    return callback().finally(() => held.delete(name));
  } } });
});

it('disposes the constructed session when an opening attachment rejects', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const failed = new Error('The attachment failed.');
  let opened: ProjectSession | undefined;
  vi.spyOn(coherenceIo, 'attachCoherence').mockImplementationOnce(async (session) => {
    opened = session;
    throw failed;
  });
  const close = vi.spyOn(ProjectSession.prototype, 'closeSafely');
  try {
    await expect(createProject(store, 'An interrupted attachment')).rejects.toBe(failed);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await opened?.close();
    store.close();
  }
});

it('forgets only the closing session’s timeline rows, ticks and suggestion preference', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const add = (id: string): void => updateTray(id, state, () => ({
    set: { rows: [{ kind: 'meta', id: 'row', nodeId: IDS.sceneA, origin: 'gesture', day: { base: null, to: 4 } }], nextId: 2 },
    ticks: new Map([['row', false]]), suggestions: false,
  }));
  add(session.projectId);
  add('another-open-project');
  try {
    expect(pendingRows(session.projectId)).toBe(1);
    await session.close();
    expect(pendingRows(session.projectId)).toBe(0);
    expect(trayOf(session.projectId)).toMatchObject({ suggestions: true });
    expect(trayOf(session.projectId).ticks.size).toBe(0);
    expect(pendingRows('another-open-project')).toBe(1);
  } finally {
    await session.close();
    forgetTray(session.projectId);
    forgetTray('another-open-project');
    store.close();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['removed', 'replaced'] as const)('detaches the original asset event targets after the globals are %s while close settles', async (change) => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const originalWindow = window;
  const originalDocument = document;
  const detachWindow = vi.spyOn(originalWindow, 'removeEventListener');
  const detachDocument = vi.spyOn(originalDocument, 'removeEventListener');
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  let finish!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(session, 'settle').mockImplementation(() => { started(); return held; });
  const closing = session.closeSafely();
  await entered;
  vi.stubGlobal('window', change === 'removed' ? undefined : new EventTarget());
  vi.stubGlobal('document', change === 'removed' ? undefined : new EventTarget());
  try {
    finish();
    await expect(closing).resolves.toBeUndefined();
    expect(detachWindow).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(detachDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  } finally {
    finish();
    await closing.catch(() => undefined);
    store.close();
  }
});

it('closes a newly created session when its first settle rejects', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const failed = new Error('The asset listing failed.');
  let opened: ProjectSession | undefined;
  const settle = vi.spyOn(ProjectSession.prototype, 'settle').mockRejectedValueOnce(failed);
  const close = vi.spyOn(ProjectSession.prototype, 'closeSafely');
  try {
    await expect(createProject(store, 'A failed open')).rejects.toBe(failed);
    opened = settle.mock.contexts[0];
    expect(close).toHaveBeenCalledOnce();
    const next = await acquireProjectLease(opened!.projectId);
    expect(next).not.toBeNull();
    next?.release();
  } finally {
    await opened?.close();
    store.close();
  }
});

it('disposes autosave and releases the lease even if settlement and cleanup both reject', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const released = vi.fn();
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null, onClosed: released });
  const settleFailure = new Error('The settle failed.');
  vi.spyOn(session, 'settle').mockRejectedValue(settleFailure);
  vi.spyOn(session.autosave, 'flush').mockRejectedValue(new Error('The flush also failed.'));
  const dispose = vi.spyOn(session.autosave, 'dispose');
  try {
    const closing = session.closeSafely();
    expect(session.handle.getSnapshot().kind).toBe('closing');
    expect(session.close()).toBe(closing);
    await expect(closing).rejects.toBe(settleFailure);
    expect(dispose).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    expect(session.handle.getSnapshot().kind).toBe('closed');
  } finally {
    await session.close().catch(() => undefined);
    store.close();
  }
});

it('drains later save queues before releasing the lease after an earlier flush rejects', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const released = vi.fn();
  const channel = new SaveChannel('settings');
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null, saveChannels: [channel], onClosed: released });
  const failed = new Error('The initial settle failed.');
  vi.spyOn(session, 'settle').mockRejectedValue(failed);
  vi.spyOn(session.autosave, 'flush').mockRejectedValue(new Error('The flush failed too.'));
  let finish!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const drain = vi.spyOn(channel, 'settled').mockImplementation(() => { started(); return held; });
  const closing = session.closeSafely();
  try {
    await Promise.race([entered, closing.catch(() => undefined)]);
    expect(drain).toHaveBeenCalledOnce();
    expect(released).not.toHaveBeenCalled();
    expect(session.handle.getSnapshot().kind).toBe('closing');
    finish();
    await expect(closing).rejects.toBe(failed);
    expect(released).toHaveBeenCalledOnce();
  } finally {
    finish();
    await closing.catch(() => undefined);
    store.close();
  }
});
