// @vitest-environment jsdom
/**
 * Lane 1's history across a reload (`src/tiptap/history-journal.ts`, editor-engine §7).
 *
 * A "reload" here is a destroy and a new mount over the same body with the journal the first editor wrote, put through `JSON` the way the app's
 * database keeps it. The cases are measured against the live editor's own undo: a rebuilt history must undo exactly what the first one would
 * have, and a journal that cannot be trusted must leave an empty history rather than a wrong document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_JOURNAL_VERSION,
  HISTORY_MAX_ENTRIES,
  type HistoryJournal,
  type HistoryPort,
  type TiptapEditorInstance,
} from '../src/tiptap/index.js';
import { focusDom, mountInto, pressUndo, tiptapOf } from './tiptap-harness.js';

/** What the app does with a journal: kept as text, read back as a new object. */
const persisted = (journal: HistoryJournal | null): HistoryJournal => {
  if (journal === null) throw new Error('the editor kept no journal');
  return JSON.parse(JSON.stringify(journal)) as HistoryJournal;
};

/** A port that remembers how often it was told, and hands in a journal. */
const portWith = (journal?: HistoryJournal): HistoryPort & { told: number } => {
  const port = {
    told: 0,
    ...(journal === undefined ? {} : { journal }),
    onChange: () => {
      port.told += 1;
    },
  };
  return port;
};

/** The writer types at the start of the scene: one Lane 1 transaction. */
const typeAtStart = (instance: TiptapEditorInstance, text: string): void => {
  instance.revealRange({ from: 0, to: 0 });
  instance.insertAtSelection(text);
};

/** Destroys the editor and opens the same body again with the journal it kept (none, when it kept none): a reload. */
const reload = async (instance: TiptapEditorInstance, journal: HistoryJournal | null) => {
  const body = instance.getContent();
  const kept = journal === null ? undefined : persisted(journal);
  instance.destroy();
  const port = portWith(kept);
  const reopened = await mountInto(body, { history: port });
  return { instance: reopened.instance, host: reopened.host, port };
};

beforeEach(() => {
  // PM history groups by `Date.now()`, so the test decides when a burst ends.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('undo survives a reload (§7)', () => {
  it('two bursts more than 500 ms apart come back as two undo events: one undo removes exactly one burst', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    vi.advanceTimersByTime(1000);
    typeAtStart(instance, 'B ');
    expect(instance.getContent()).toBe('B A Hello.\n');

    const { instance: reopened } = await reload(instance, instance.historyJournal());

    expect(reopened.getContent()).toBe('B A Hello.\n');
    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe('A Hello.\n');
    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe('Hello.\n');
    expect(reopened.undo()).toBe(false);
  });

  it('control: two bursts inside the 500 ms window are one event, before and after the reload', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    vi.advanceTimersByTime(100);
    typeAtStart(instance, 'B ');

    const { instance: reopened } = await reload(instance, instance.historyJournal());

    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe('Hello.\n');
  });

  it('Ctrl+Z reaches the rebuilt history through the keymap', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    const { instance: reopened, host } = await reload(instance, instance.historyJournal());

    pressUndo(host);

    expect(reopened.getContent()).toBe('Hello.\n');
  });

  it('an undo that was made before the reload is replayed, so the document and what is left to undo agree', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    vi.advanceTimersByTime(1000);
    typeAtStart(instance, 'B ');
    instance.undo();
    expect(instance.getContent()).toBe('A Hello.\n');

    const { instance: reopened } = await reload(instance, instance.historyJournal());

    expect(reopened.getContent()).toBe('A Hello.\n');
    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe('Hello.\n');
    expect(reopened.undo()).toBe(false);
  });

  it('typing after the reload continues the same history, and a second reload still rebuilds it', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    const first = await reload(instance, instance.historyJournal());
    vi.advanceTimersByTime(1000);
    typeAtStart(first.instance, 'B ');

    const second = await reload(first.instance, first.instance.historyJournal());

    expect(second.instance.undo()).toBe(true);
    expect(second.instance.getContent()).toBe('A Hello.\n');
    expect(second.instance.undo()).toBe(true);
    expect(second.instance.getContent()).toBe('Hello.\n');
  });

  it('is told when the history changes, and the journal is empty before anything is typed', async () => {
    const port = portWith();
    const { instance } = await mountInto('Hello.\n', { history: port });
    expect(instance.historyJournal()).toBeNull();
    typeAtStart(instance, 'A ');
    expect(port.told).toBeGreaterThan(0);
    expect(instance.historyJournal()?.entries).toHaveLength(1);
  });
});

describe('a journal that cannot be trusted leaves an empty history', () => {
  it('a body that differs from the one the journal replays to discards it, and the app is told so it can drop the record', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    const kept = persisted(instance.historyJournal());
    instance.destroy();

    const port = portWith(kept);
    // The stored body changed outside this tab: the journal's steps no longer lead to it.
    const { instance: reopened } = await mountInto('Elsewhere, it changed.\n', { history: port });

    expect(reopened.getContent()).toBe('Elsewhere, it changed.\n');
    expect(reopened.undo()).toBe(false);
    expect(reopened.getContent()).toBe('Elsewhere, it changed.\n');
    expect(port.told).toBeGreaterThan(0);
    expect(reopened.historyJournal()).toBeNull();
  });

  it('a journal of another version, or made on another schema, is discarded', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    const kept = persisted(instance.historyJournal());
    const body = instance.getContent();
    instance.destroy();

    for (const changed of [
      { ...kept, version: HISTORY_JOURNAL_VERSION + 1 },
      { ...kept, schema: `${kept.schema},suggestion()` },
    ]) {
      const { instance: reopened } = await mountInto(body, { history: portWith(changed) });
      expect(reopened.undo()).toBe(false);
      expect(reopened.getContent()).toBe(body);
    }
  });

  it('a step that does not apply discards the journal, and an unreadable step throws nothing', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    const kept = persisted(instance.historyJournal());
    const body = instance.getContent();
    instance.destroy();

    const apart: HistoryJournal = { ...kept, entries: [{ kind: 'edit', steps: [{ stepType: 'replace', from: 900, to: 950 }], time: 1 }] };
    const nonsense: HistoryJournal = { ...kept, entries: [{ kind: 'edit', steps: [{ stepType: 'no-such-step' }], time: 1 }] };
    const undoFirst: HistoryJournal = { ...kept, entries: [{ kind: 'undo' }] };
    for (const journal of [apart, nonsense, undoFirst]) {
      const { instance: reopened } = await mountInto(body, { history: portWith(journal) });
      expect(reopened.undo()).toBe(false);
      expect(reopened.getContent()).toBe(body);
    }
  });
});

describe('an agent apply starts a new ring (§7: Lane 2 never enters Lane 1)', () => {
  it('after the reload the writer’s undo reaches only what was typed after the agent’s text, and never removes it', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'Mine ');
    vi.advanceTimersByTime(1000);
    // Past the writer's text, so the in-tab history survives it; the journal restarts all the same.
    instance.replaceRange({ from: 10, to: 11 }, '!', { historyExcluded: true });
    expect(instance.getContent()).toBe('Mine Hello!\n');
    expect(instance.historyJournal()).toBeNull();
    vi.advanceTimersByTime(1000);
    typeAtStart(instance, 'Then ');

    const { instance: reopened } = await reload(instance, instance.historyJournal());

    expect(reopened.getContent()).toBe('Then Mine Hello!\n');
    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe('Mine Hello!\n');
    // `Mine ` was typed before the agent's apply, so it is not in the new ring, and the agent's `!` is not either.
    expect(reopened.undo()).toBe(false);
    expect(reopened.getContent()).toBe('Mine Hello!\n');
  });

  it('Ctrl+Z after a reload that follows only an agent apply removes nothing', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    instance.replaceRange({ from: 0, to: 2 }, 'Ours ', { historyExcluded: true });
    expect(instance.getContent()).toBe('Ours Hello.\n');

    const { instance: reopened, host } = await reload(instance, instance.historyJournal());
    pressUndo(host);

    expect(reopened.getContent()).toBe('Ours Hello.\n');
  });

  it('a restore (setContent on the agent lane) starts a new ring too', async () => {
    const { instance } = await mountInto('Hello.\n');
    typeAtStart(instance, 'A ');
    await instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    expect(instance.historyJournal()).toBeNull();
  });
});

describe('the ring is bounded', () => {
  it('past its bound the oldest entries are folded into the base, and the history still rebuilds to the same document', async () => {
    const { host, instance } = await mountInto('Hello.\n');
    const editor = tiptapOf(focusDom(host));
    const typed = HISTORY_MAX_ENTRIES + 100;
    for (let i = 0; i < typed; i += 1) {
      editor.view.dispatch(editor.state.tr.insertText('x', 1 + i));
    }
    const journal = instance.historyJournal();
    expect(journal).not.toBeNull();
    expect(journal!.entries.length).toBeLessThanOrEqual(HISTORY_MAX_ENTRIES);
    expect(journal!.entries.length).toBeGreaterThan(0);
    expect(journal!.baseBody).toContain('x');

    const before = instance.getContent();
    const { instance: reopened } = await reload(instance, journal);

    expect(reopened.getContent()).toBe(before);
    expect(reopened.undo()).toBe(true);
    // The folded entries are history the library would have dropped anyway: some typing is left, and the document is still the writer's.
    expect(reopened.getContent()).toContain('x');
    expect(reopened.getContent()).toContain('Hello.');
  });
});
