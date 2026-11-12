// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyManifest, createProjectState } from '@caotang/store';
import type { ProjectSession } from '../src/app/session.js';
import type { StoredMark } from '../src/app/store-rebase.js';
import { useStoreRebase } from '../src/components/use-store-rebase.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const docId = 'scene';
const opened = { body: 'Opened.', revision: 1 };
let session: ProjectSession;
let own: StoredMark | null;
let pending: ReturnType<typeof deferred>[];
let adopted: StoredMark[];
let failed: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLElement;

function View() {
  const rebase = useStoreRebase({
    session, docId, initial: opened, failed,
    apply: async (mark, current) => {
      const flush = deferred();
      pending.push(flush);
      await flush.promise;
      if (!current()) return false;
      adopted.push(mark);
    },
  });
  return <output data-state={rebase.state} />;
}

function store(mark: StoredMark) {
  session.state.documents.set(docId, { id: docId, ...mark });
}

async function move(mark: StoredMark) {
  store(mark);
  await act(async () => root.render(<View />));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  pending = [];
  adopted = [];
  own = null;
  failed = vi.fn();
  session = { state: createProjectState(createEmptyManifest('Rebase', new Date())), lastWritten: () => own } as unknown as ProjectSession;
  store(opened);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<View />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the shared store rebase hook', () => {
  it('keeps a pending media flush unsynced and applies only the latest store move', async () => {
    await move({ body: 'Undo.', revision: 2 });
    expect(host.querySelector('output')?.dataset.state).toBe('loading');
    await move({ body: 'Restore.', revision: 3 });
    await act(async () => pending[0]!.resolve());
    expect(adopted).toEqual([]);
    expect(host.querySelector('output')?.dataset.state).toBe('loading');
    await act(async () => pending[1]!.resolve());
    expect(adopted).toEqual([{ body: 'Restore.', revision: 3 }]);
    expect(host.querySelector('output')?.dataset.state).toBe('ready');
  });

  it('checks the live store even before React observes its next notification', async () => {
    await move({ body: 'Undo.', revision: 2 });
    store({ body: 'Newer.', revision: 3 });
    await act(async () => pending[0]!.resolve());
    expect(adopted).toEqual([]);
  });

  it('invalidates a pending flush when a newer own write is acknowledged', async () => {
    await move({ body: 'Undo.', revision: 2 });
    own = { body: 'Typed.', revision: 3 };
    await move(own);
    await act(async () => pending[0]!.resolve());
    expect(adopted).toEqual([]);
    expect(host.querySelector('output')?.dataset.state).toBe('ready');
  });

  it('invalidates a pending flush when the view unmounts', async () => {
    await move({ body: 'Undo.', revision: 2 });
    await act(async () => root.render(null));
    await act(async () => pending[0]!.resolve());
    expect(adopted).toEqual([]);
  });

  it('publishes a failure only for the current flush, without claiming readiness', async () => {
    await move({ body: 'Undo.', revision: 2 });
    await move({ body: 'Restore.', revision: 3 });
    await act(async () => pending[0]!.reject(new Error('Old flush')));
    expect(failed).not.toHaveBeenCalled();
    const error = new Error('Current flush');
    await act(async () => pending[1]!.reject(error));
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(host.querySelector('output')?.dataset.state).toBe('failed');
  });
});
