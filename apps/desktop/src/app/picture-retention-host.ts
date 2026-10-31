/**
 * The roots of the picture sweep's retention inventory that only the app can read (pictures.md §6.6.1, roots 4 to 7): the open undo
 * groups, the checkpoints, the pending and unsent journals, the editor-history journals, and whatever else the session is told it holds
 * (an agent card's drafts). The store derives the rest from the project state (`stateRetentionRoots`).
 *
 * Every root here either lists everything it retains or throws, and a throw makes the whole snapshot non-authoritative, so the sweep
 * refuses and removes nothing. A stored value this build cannot parse is a throw, never "empty": the journals are scanned as the raw
 * JSON they were stored as, so a shape this build does not know still names its pictures.
 */

import { t } from '@lingui/core/macro';
import type { UndoStore } from '@caotang/bus';
import {
  readBodySnapshots,
  textsRetentionRoot,
  undoGroupRetention,
  valueRetentionRoot,
  type RetentionRoot,
  type RuntimeStore,
  type UndoRetentionLedger,
} from '@caotang/store';

import { historyKey, loadHistoryJournal } from './history-store.js';
import type { AppDb } from './app-db.js';
import { pendingKey } from './pending-journal.js';
import { unsentKey, type UnsentStorage } from './unsent-copy.js';

/* lingui-set comment="A root of the picture sweep's inventory, named in the sentence that says why a sweep was refused. key is a document's journal key; root is the name of another root; reason is a sentence." */

export interface HostRetentionParts {
  readonly projectId: string;
  readonly store: RuntimeStore;
  readonly undo: () => UndoStore;
  readonly ledger: UndoRetentionLedger;
  /** The browser's `localStorage`, where the pending and unsent journals live; `undefined` where the browser keeps none. */
  readonly storage: UnsentStorage | undefined;
  /** The app database the editor-history journals live in; `null` where there is none (nothing is kept then). */
  readonly appDb: () => AppDb | null;
}

/** A stored JSON value, parsed. An absent key is `null`; a value that is not JSON, or a storage that throws, refuses the sweep. */
function storedJson(storage: UnsentStorage | undefined, key: string): unknown {
  if (storage === undefined) return null;
  const raw = storage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw) as unknown;
}

/** The roots the app holds beside the project state. `extra` is read at each sweep, so a root registered later is in it. */
export function hostRetentionRoots(parts: HostRetentionParts, extra: () => readonly RetentionRoot[] = () => []): RetentionRoot[] {
  return [
    {
      name: t`the open undo groups`,
      list: async () => ({ authoritative: true, ids: undoGroupRetention(parts.undo().groups(), parts.ledger).ids }),
    },
    textsRetentionRoot(t`the checkpoints`, async () => (await readBodySnapshots(parts.store, parts.projectId)).map((row) => row.body)),
    valueRetentionRoot(t`the pending journal`, () => storedJson(parts.storage, pendingKey(parts.projectId))),
    valueRetentionRoot(t`the words kept from a stopped tab`, () => storedJson(parts.storage, unsentKey(parts.projectId))),
    valueRetentionRoot(t`the editor history journals`, async () => {
      const db = parts.appDb();
      if (db?.history === undefined) return null;
      const mine = (await db.history.list()).filter((meta) => meta.projectId === parts.projectId);
      const journals: unknown[] = [];
      for (const meta of mine) {
        // A journal that the list names and the read cannot give is unread, which is a refusal, not an empty journal.
        const journal = await loadHistoryJournal(parts.projectId, meta.docId, db);
        if (journal === undefined) {
          const key = historyKey(parts.projectId, meta.docId);
          throw new Error(t`the journal of ${{ key }} could not be read`);
        }
        journals.push(journal);
      }
      return journals;
    }),
    {
      name: t`what else the session holds`,
      list: async () => {
        const merged = new Map<string, readonly string[]>();
        for (const root of extra()) {
          const listing = await root.list();
          if (!listing.authoritative) return { authoritative: false, reason: t`${{ root: root.name }}: ${{ reason: listing.reason }}` };
          for (const [id, why] of listing.ids) merged.set(id, [...(merged.get(id) ?? []), ...why.map((reason) => `${root.name}: ${reason}`)]);
        }
        return { authoritative: true, ids: merged };
      },
    },
  ];
}
