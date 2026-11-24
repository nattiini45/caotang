/**
 * The keychain as the page may use it, with each secret's address kept beside it — desktop.md §The keychain.
 *
 * `os-vault.ts` knows how to seal one value, read it back, put it back and remove it. This file is the rule above it: a secret
 * belongs to the address the writer entered it for, and only three calls may change that pairing. `put` stores a key for an
 * address and refuses one already bound elsewhere, so a page cannot point a saved key at an address of its own choosing. The
 * address is written after the secret, never before it, so an interruption can only leave a key with no address.
 * `putReplacement` is the writer's own key typed again for an endpoint they changed, which takes the new address with it.
 * `remove` frees the id. A key nothing has placed — one stored before these pairings existed — stays denied; the writer enters
 * it again for the address they mean, which is the one act that gives a secret an address.
 *
 * **A write and its undo carry the address too.** A `put` or a headers edit remembers the address that id had before it, so
 * `restore` puts back the secret and the address together: a page may undo a write it decided against, and cannot undo its way
 * into sending an older secret to an address the writer never entered it for (#864).
 *
 * **A request reads its secret where a write cannot move it.** {@link BoundKeyVault.readFor} takes the same turn a write does,
 * so the address an id is bound to when its secret is read is the address that secret was entered for: a replacement hides the
 * id until the new secret is sealed and placed, and no request is answered with the older secret at the new endpoint.
 */

import { KeyBoundElsewhere, type KeyBindings } from './key-bindings.js';
import type { OsKeyVault, OsVaultPayload } from './os-vault.js';

export interface BoundKeyVault {
  available(): Promise<boolean>;
  /** Stores a payload for one address, refusing an id bound to another. */
  put(id: string, payload: OsVaultPayload, origin: string): Promise<void>;
  /** Stores the key a writer typed again for a changed endpoint, and moves the id's address with it. */
  putReplacement(id: string, payload: OsVaultPayload, origin: string): Promise<void>;
  /** Replaces the extra headers of a stored key and keeps its key and its address. */
  putHeaders(id: string, headers: Readonly<Record<string, string>>): Promise<void>;
  remove(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
  /** Puts back what the last write for `id` replaced, the address it belonged to included. */
  restore(id: string): Promise<void>;
  revision(id: string): Promise<string>;
  headers(id: string): Promise<Readonly<Record<string, string>> | undefined>;
  /** The ids bound to one address: what a request to it may carry. */
  keysFor(origin: string): readonly string[];
  /**
   * The secrets for a request to `origin`, read in the same turn a write takes. Undefined when an id is not bound to this
   * address, or holds nothing: a secret is only ever handed over for the address it belongs to at the moment it is read.
   */
  readFor(origin: string, ids: readonly string[]): Promise<ReadonlyMap<string, OsVaultPayload> | undefined>;
}

export function openBoundKeyVault(vault: OsKeyVault, bindings: KeyBindings): BoundKeyVault {
  let writes: Promise<unknown> = Promise.resolve();
  /** The address each id had before the write that can still be undone, `undefined` when it had none. */
  const undo = new Map<string, string | undefined>();

  /** One turn at a time, so the sealed entry and its address move together however many calls arrive at once. */
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const pending = writes.then(work);
    writes = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const setAddress = async (id: string, origin: string | undefined): Promise<void> => {
    if (origin === undefined) await bindings.forget(id);
    else await bindings.rebind(id, origin);
  };

  /** The undo record as it stands, and the function that puts it back: what a write that did not happen costs. */
  const snapshot = (id: string): (() => void) => {
    const recorded = undo.has(id) ? { had: true as const, origin: undo.get(id) } : { had: false as const };
    return () => {
      if (recorded.had) undo.set(id, recorded.origin);
      else undo.delete(id);
    };
  };

  /**
   * A write that may change the address, and the undo of both halves. A binding that cannot be made leaves the vault untouched
   * and the undo record as it was; a seal that fails puts the address back, so a key that was not stored never leaves its id
   * pointing somewhere the writer did not enter it for.
   *
   * **The undo record never runs ahead of the vault's.** The vault records its own undo inside `put`, so the address this
   * session remembers for that undo is written only once the binding and the vault's write have both been attempted, and is put
   * back whenever the write fails. A rejected write that left a later address in this map would let `restore` pair an older
   * secret with an address the writer never entered it for.
   *
   * **A rejected write only puts the address back when the secret came back too.** A `put` can fail after its entry is written,
   * so the id may hold the key just entered; that key only ever goes to the address it was entered for.
   */
  const write = (id: string, payload: OsVaultPayload, origin: string, replace: boolean): Promise<void> => serialize(async () => {
    const previous = bindings.originOf(id);
    // An id bound elsewhere is refused before the vault is touched; only the writer's own replacement may move one.
    if (!replace && previous !== undefined && previous !== origin) throw new KeyBoundElsewhere(id, previous);

    /** Puts the undo record back the way the vault's own undo describes it after a write that did not happen. */
    const restoreRecord = snapshot(id);

    // A replacement hides the id for the whole write: a request made while the new secret is being sealed is refused, rather than
    // answered with the older secret at the address the writer just moved to. An id with no address is already hidden.
    if (replace && previous !== undefined) await bindings.forget(id);

    // The secret is stored while the id is unbound or already at this address, and the address is written only after the seal
    // holds. No interruption — a refused binding, a failed seal, or the process stopping between the two — can leave an older
    // secret paired with an address the writer did not enter it for: an id that was not placed is denied.
    const before = await vault.revision(id);
    /** Whether the vault still holds the secret this id had before the write: an unreadable vault counts as changed. */
    const holdsBefore = async (): Promise<boolean> => {
      try {
        return await vault.revision(id) === before;
      } catch {
        return false;
      }
    };
    undo.set(id, previous);
    try {
      await vault.put(id, payload);
    } catch (error) {
      // A write that is reported failed can still have stored the secret: the read-back is what fails, and the entry it means
      // to put back may not be written either. Only a vault that still shows the secret this id had before the write may keep
      // the address, because the one it shows otherwise is the key just entered — sending that to the older endpoint would
      // hand over the key the writer typed for the new one. Such an id is left unbound, and denied, until entered again.
      const unchanged = previous === origin || await holdsBefore();
      try {
        if (unchanged) await setAddress(id, previous);
      } finally {
        restoreRecord();
      }
      throw error;
    }
    if (!replace && previous === origin) return;

    try {
      await bindings.bind(id, origin);
    } catch (error) {
      // The new secret is stored and its address could not be written. A replacement puts back the key it replaced, so the
      // writer keeps the one that was working; a first save leaves the new key unbound and denied, to be entered again.
      if (replace && previous !== undefined) {
        try {
          await vault.restore(id);
          undo.delete(id);
          await setAddress(id, previous);
        } catch {
          // Nothing is sent with an id that has no address.
          undo.set(id, previous);
        }
      }
      throw error;
    }
  });

  return {
    available: () => vault.available(),

    put: (id, payload, origin) => write(id, payload, origin, false),

    putReplacement: (id, payload, origin) => write(id, payload, origin, true),

    putHeaders: (id, headers) => serialize(async () => {
      // A key that is not stored is not created by a headers edit, so there is nothing to remember an address for either.
      if (!await vault.has(id)) return;
      const restoreRecord = snapshot(id);
      undo.set(id, bindings.originOf(id));
      try {
        await vault.putHeaders(id, headers);
      } catch (error) {
        // The headers edit did not happen, so the undo must still describe the write before it: an address recorded for an
        // edit that failed would send the secret a later undo puts back to an endpoint it was never entered for.
        restoreRecord();
        throw error;
      }
    }),

    remove: (id) => serialize(async () => {
      await vault.remove(id);
      // The id is free again: nothing is stored under it, so nothing may be sent with it either.
      await bindings.forget(id);
    }),

    has: (id) => vault.has(id),

    restore: (id) => serialize(async () => {
      // The id is hidden while its secret goes back, so no request is answered with the restored secret at the address the
      // write being undone gave it. Throws when there is nothing to put back, and then the id goes back where it was.
      const current = bindings.originOf(id);
      if (current !== undefined) await bindings.forget(id);
      try {
        await vault.restore(id);
      } catch (error) {
        await setAddress(id, current);
        throw error;
      }
      const previous = undo.get(id);
      undo.delete(id);
      // A prior address that cannot be written leaves the key with none: denied, never at the address it was moved away from.
      await setAddress(id, previous);
    }),

    revision: (id) => vault.revision(id),

    headers: (id) => vault.headers(id),

    keysFor: (origin) => bindings.keysFor(origin),

    readFor: (origin, ids) => serialize(async () => {
      const secrets = new Map<string, OsVaultPayload>();
      for (const id of ids) {
        if (bindings.originOf(id) !== origin) return undefined;
        const payload = await vault.read(id);
        if (payload === undefined) return undefined;
        secrets.set(id, payload);
      }
      return secrets;
    }),
  };
}
