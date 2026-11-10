import { checkMachine } from '@caotang/machine/testing';
import { describe, expect, it } from 'vitest';

import { tabStopMachine, TabStop, type TabStopState, type TabStopEvent } from '../src/app/tab-stop.js';
import { persistenceMachine, type PersistenceState, type PersistenceEvent } from '../src/app/persistence-model.js';
import { pendingEntryMachine, type PendingEntryState, type PendingEntryEvent } from '../src/app/pending-entry.js';
import { PendingJournal, readPending, pendingKey, type PendingSource } from '../src/app/pending-journal.js';
import { readUnsentEntries, restoreStep, unsentKey, writeUnsentEntry, type UnsentStorage } from '../src/app/unsent-copy.js';

function storage(): UnsentStorage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; }, key: (index) => [...rows.keys()][index] ?? null,
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, text) => { rows.set(key, text); }, removeItem: (key) => { rows.delete(key); },
  };
}

const entry = { docId: 'scene', body: 'The latest words.', baseRevision: 3, at: '2026-11-09T10:00:00.000Z' };

describe('the stopped-tab machines', () => {
  it('exhaustively agrees with every transition table', () => {
    const tabStates: TabStopState[] = [{ kind: 'running' }, { kind: 'stopped', cause: 'updated', keptLatest: false }];
    const tabEvents: TabStopEvent[] = [{ type: 'stop', cause: 'newer-text' }, { type: 'keep', landed: true }];
    expect(checkMachine(tabStopMachine, { states: tabStates, events: tabEvents })).toEqual([]);
    const persistStates: PersistenceState[] = [{ kind: 'idle' }, { kind: 'writing' }, { kind: 'failed', error: 'disk' }, { kind: 'conflict', error: 'stale' }];
    const persistEvents: PersistenceEvent[] = [{ type: 'write' }, { type: 'saved' }, { type: 'fail', error: 'disk' }, { type: 'stop', error: 'stale' }];
    expect(checkMachine(persistenceMachine, { states: persistStates, events: persistEvents })).toEqual([]);
    const pendingStates: PendingEntryState[] = [{ kind: 'empty' }, { kind: 'held', entry }, { kind: 'written', entry }, { kind: 'pruned' }, { kind: 'cleared-for-stop' }];
    const pendingEvents: PendingEntryEvent[] = [{ type: 'hold', entry }, { type: 'write' }, { type: 'prune', body: entry.body }, { type: 'prune', body: 'Older' }, { type: 'drop' }, { type: 'stop', copyLanded: true }, { type: 'stop', copyLanded: false }];
    expect(checkMachine(pendingEntryMachine, { states: pendingStates, events: pendingEvents })).toEqual([]);
  });

  it('keeps a cause and copy result together, isolated from another session', () => {
    const first = new TabStop('project', 'first');
    first.send({ type: 'stop', cause: 'updated' });
    first.send({ type: 'keep', landed: true });
    const second = new TabStop('project', 'second');
    expect(second.getSnapshot()).toEqual({ kind: 'running' });
    second.send({ type: 'stop', cause: 'newer-text' });
    expect(first.getSnapshot()).toEqual({ kind: 'stopped', cause: 'updated', keptLatest: true });
    expect(second.getSnapshot()).toEqual({ kind: 'stopped', cause: 'newer-text', keptLatest: false });
  });

  it('does not change a stop cause, restart persistence or discard a journal before a copy lands', () => {
    const stopped: TabStopState = { kind: 'stopped', cause: 'updated', keptLatest: true };
    expect(tabStopMachine.step(stopped, { type: 'stop', cause: 'newer-text' })).toBe(stopped);
    const conflict: PersistenceState = { kind: 'conflict', error: 'stale' };
    expect(persistenceMachine.step(conflict, { type: 'write' })).toBe(conflict);
    const held: PendingEntryState = { kind: 'held', entry };
    expect(pendingEntryMachine.step(held, { type: 'stop', copyLanded: false })).toBe(held);
    expect(pendingEntryMachine.step(held, { type: 'stop', copyLanded: true })).toEqual({ kind: 'cleared-for-stop' });
  });

  it('reads versionless old-build entries and writes the same shapes', () => {
    const kept = storage();
    kept.setItem(pendingKey('project'), JSON.stringify([entry]));
    const oldUnsent = [{ stopId: 'old-stop', savedAt: entry.at, documents: [{ docId: 'scene', title: 'Scene', body: entry.body }] }];
    kept.setItem(unsentKey('project'), JSON.stringify(oldUnsent));
    expect(readPending(kept, 'project')).toEqual([entry]);
    expect(readUnsentEntries(kept, 'project')).toEqual(oldUnsent);
    writeUnsentEntry(kept, 'project', 'new-stop', [{ docId: 'scene', title: 'Scene', body: 'New stop words.' }]);
    const entries = readUnsentEntries(kept, 'project');
    expect(entries[0]).toEqual(oldUnsent[0]);
    expect(Object.keys(entries[1]!).sort()).toEqual(['documents', 'savedAt', 'stopId']);
    const stop = new TabStop('project', 'new-stop');
    stop.send({ type: 'stop', cause: 'newer-text' });
    expect(stop.keptInBrowser(kept)).toBe(false);
    stop.send({ type: 'keep', landed: true });
    expect(stop.keptInBrowser(kept)).toBe(true);
    kept.removeItem(unsentKey('project'));
    expect(stop.keptInBrowser(kept)).toBe(false);
  });

  it('keeps the journal after a refused copy, then clears it when the stop keeps the words', () => {
    const kept = storage();
    const source: PendingSource = {
      docIds: () => ['scene'], bodyOf: () => entry.body,
      stored: () => ({ body: 'Older', revision: 3 }), pendingBodyOf: () => null,
      dirtyDocIds: () => [], stopped: () => false,
    };
    const journal = new PendingJournal(kept, 'project', source, () => entry.at);
    journal.keep();
    expect(JSON.parse(kept.getItem(pendingKey('project'))!)).toEqual([entry]);
    journal.clearForStop(false);
    expect(readPending(kept, 'project')).toEqual([entry]);
    journal.clearForStop(true);
    expect(readPending(kept, 'project')).toEqual([]);
  });

  it('names the put-back step without making a second document on retry', () => {
    const doc = { docId: 'scene', title: 'Scene', body: entry.body, restoredAs: 'restored' };
    expect(restoreStep(doc, undefined)).toEqual({ kind: 'create' });
    expect(restoreStep(doc, { body: '' })).toEqual({ kind: 'write', docId: 'restored' });
    expect(restoreStep(doc, { body: 'Writer edited this.' })).toEqual({ kind: 'done' });
  });

  it('drops earlier held words when the writer returns to the stored body before saving', () => {
    const kept = storage();
    let body = entry.body;
    const source: PendingSource = {
      docIds: () => ['scene'], bodyOf: () => body,
      stored: () => ({ body: 'Older', revision: 3 }), pendingBodyOf: () => null,
      dirtyDocIds: () => [], stopped: () => false,
    };
    const journal = new PendingJournal(kept, 'project', source, () => entry.at);
    journal.keep();
    expect(readPending(kept, 'project')).toEqual([entry]);
    body = 'Older';
    journal.keep();
    expect(readPending(kept, 'project')).toEqual([]);
  });
});
