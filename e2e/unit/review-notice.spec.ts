import { expect, test } from '@playwright/test';

import type { AppDb } from '../../apps/desktop/src/app/app-db.js';
import { recordPending, reviewKey, takePending } from '../../apps/desktop/src/app/review-notice.js';
import { UNRESOLVED_NOTICE, landingNotice, pendingLabel, pendingNotice } from '../../apps/desktop/src/app/review-text.js';

/** An in-memory app database: the calls the notice makes, over a map. */
function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string): Promise<T | undefined> => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, structuredClone(value));
    },
    list: async () => [],
    delete: async (key: string): Promise<void> => {
      rows.delete(key);
    },
    close: (): void => {},
  };
}

test.describe('the notice a reload owes for suggestions still marked (editor-engine §15)', () => {
  test('a count is kept per document, replaced as it changes, and removed when it reaches zero', async () => {
    const db = memoryDb();
    await recordPending('p1', 'd1', 3, db);
    expect(db.rows.get(reviewKey('p1', 'd1'))).toEqual({ docId: 'd1', count: 3 });
    await recordPending('p1', 'd1', 1, db);
    expect(db.rows.get(reviewKey('p1', 'd1'))).toEqual({ docId: 'd1', count: 1 });
    await recordPending('p1', 'd1', 0, db);
    expect(db.rows.size).toBe(0);
  });

  test('the record is read once and then gone, so the notice is shown once', async () => {
    const db = memoryDb();
    await recordPending('p1', 'd1', 2, db);
    expect(await takePending('p1', 'd1', db)).toEqual({ docId: 'd1', count: 2 });
    expect(await takePending('p1', 'd1', db)).toBeNull();
  });

  test('another project or document has its own record', async () => {
    const db = memoryDb();
    await recordPending('p1', 'd1', 2, db);
    expect(await takePending('p2', 'd1', db)).toBeNull();
    expect(await takePending('p1', 'd2', db)).toBeNull();
    expect(db.rows.size).toBe(1);
  });

  test('a record that is not a positive count is not a notice', async () => {
    const db = memoryDb();
    db.rows.set(reviewKey('p1', 'd1'), { docId: 'd1', count: 0 });
    expect(await takePending('p1', 'd1', db)).toBeNull();
    db.rows.set(reviewKey('p1', 'd1'), { docId: 'd1', count: 'many' });
    expect(await takePending('p1', 'd1', db)).toBeNull();
  });

  test('with no database, or one that throws, nothing is kept and nothing throws', async () => {
    await recordPending('p1', 'd1', 2, null);
    expect(await takePending('p1', 'd1', null)).toBeNull();
    const broken: AppDb = {
      ...memoryDb(),
      get: async () => {
        throw new Error('closed');
      },
      put: async () => {
        throw new Error('full');
      },
    };
    await recordPending('p1', 'd1', 2, broken);
    expect(await takePending('p1', 'd1', broken)).toBeNull();
  });

  test('counts the suggestions that wait, in the singular and the plural', () => {
    expect(pendingLabel(1)).toBe('1 suggestion pending review');
    expect(pendingLabel(4)).toBe('4 suggestions pending review');
  });

  test('says what was kept and where to find the way back, in the singular and the plural', () => {
    expect(pendingNotice(3)).toBe(
      '3 suggestions from the last agent turn were kept as written on reload — ‘Restore to before this turn’ is on that turn’s card in the agent panel.',
    );
    expect(pendingNotice(1)).toContain('1 suggestion from the last agent turn was kept as written on reload');
  });

  test('says nothing about an edit that replaced the text in a plain editor or that a newer load replaced, and says why for every other fallback', () => {
    expect(landingNotice({ landed: 'suggestions', suggestions: 2 })).toBeNull();
    expect(landingNotice({ landed: 'replaced', reason: 'off' })).toBeNull();
    expect(landingNotice({ landed: 'replaced', reason: 'superseded' })).toBeNull();
    expect(landingNotice({ landed: 'replaced', reason: 'unsaved' })).toContain('had typing that was not saved yet');
    for (const reason of ['diff', 'mismatch'] as const) {
      const said = landingNotice({ landed: 'replaced', reason });
      expect(said).toContain('could not be marked for review');
      expect(said).toContain('‘Restore to before this turn’ is on that turn’s card in the agent panel');
    }
    // A review layer that failed to load in review mode is not the same as a mode that is off.
    expect(landingNotice({ landed: 'replaced', reason: 'no-layer' })).toContain('The review marks could not be loaded');
    expect(landingNotice({ landed: 'replaced', reason: 'no-layer' })).not.toContain('Nothing was lost');
    expect(landingNotice({ landed: 'replaced', reason: 'unsaved' })).toContain('not saved yet');
  });

  test('a change that could not be resolved names the ways back', () => {
    expect(UNRESOLVED_NOTICE).toContain('could not be resolved');
    expect(UNRESOLVED_NOTICE).toContain('Ctrl+Z');
    expect(UNRESOLVED_NOTICE).toContain('‘Restore to before this turn’ is on that turn’s card in the agent panel');
  });

  test('every restore label the notices name is the button the agent panel shows', async () => {
    const { readFile } = await import('node:fs/promises');
    const panel = await readFile('apps/desktop/src/components/AgentPanel.tsx', 'utf8');
    expect(panel).toContain('Restore to before this turn');
  });
});
