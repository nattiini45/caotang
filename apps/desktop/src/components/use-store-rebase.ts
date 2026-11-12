import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getBody, getRevision } from '@caotang/store';
import { isOwnWrite, stepStoreRebase, type StoredMark, type StoreRebaseState } from '../app/store-rebase.js';
import type { ProjectSession } from '../app/session.js';

export function useStoreRebase({ session, docId, enabled = true, initial = null, apply, acknowledge, matches, failed }: {
  readonly session: ProjectSession;
  readonly docId: string;
  readonly enabled?: boolean;
  readonly initial?: StoredMark | null;
  readonly apply: (mark: StoredMark, current: () => boolean) => Promise<boolean | void>;
  readonly acknowledge?: (mark: StoredMark) => void;
  readonly matches?: (mark: StoredMark) => boolean;
  readonly failed: (error: unknown) => void;
}): { readonly ready: boolean; readonly state: 'loading' | 'ready' | 'failed'; readonly seed: (mark: StoredMark) => void } {
  const slot = useRef<StoreRebaseState>({ kind: initial === null ? 'idle' : 'synced', synced: initial, token: 0 });
  const callbacks = useRef({ apply, acknowledge, matches, failed });
  useLayoutEffect(() => { callbacks.current = { apply, acknowledge, matches, failed }; });
  const [status, setStatus] = useState<{ mark: StoredMark; state: 'ready' | 'failed' } | null>(null);
  const seed = useCallback((mark: StoredMark) => {
    slot.current = stepStoreRebase(slot.current, { type: 'acknowledge', mark });
  }, []);
  const stored = getBody(session.state, docId);
  const revision = getRevision(session.state, docId);

  useEffect(() => {
    if (!enabled) return;
    const mark = { body: stored, revision };
    const seen = slot.current.synced;
    if (seen !== null && seen.body === stored && seen.revision === revision) {
      slot.current = stepStoreRebase(slot.current, { type: 'acknowledge', mark });
      setStatus({ mark, state: 'ready' });
    } else if (isOwnWrite(session.lastWritten(docId), stored, revision) || callbacks.current.matches?.(mark) === true) {
      callbacks.current.acknowledge?.(mark);
      slot.current = stepStoreRebase(slot.current, { type: 'acknowledge', mark });
      setStatus({ mark, state: 'ready' });
    } else {
      slot.current = stepStoreRebase(slot.current, { type: 'begin', mark });
      const token = slot.current.token;
      setStatus(null);
      const current = (): boolean => slot.current.kind === 'rebasing' && slot.current.token === token
        && getBody(session.state, docId) === stored && getRevision(session.state, docId) === revision;
      void (async () => {
        try {
          const landed = await callbacks.current.apply(mark, current);
          if (!current()) return;
          if (landed === false) {
            slot.current = stepStoreRebase(slot.current, { type: 'fail', token });
            setStatus({ mark, state: 'failed' });
            return;
          }
          callbacks.current.acknowledge?.(mark);
          slot.current = stepStoreRebase(slot.current, { type: 'land', token });
          setStatus({ mark, state: 'ready' });
        } catch (error: unknown) {
          if (!current()) return;
          slot.current = stepStoreRebase(slot.current, { type: 'fail', token });
          setStatus({ mark, state: 'failed' });
          callbacks.current.failed(error);
        }
      })();
    }
    return () => {
      slot.current = stepStoreRebase(slot.current, { type: 'invalidate' });
    };
  }, [session, docId, stored, revision, enabled]);

  const state = enabled && status?.mark.body === stored && status.mark.revision === revision ? status.state : 'loading';
  return { ready: state === 'ready', state, seed };
}
