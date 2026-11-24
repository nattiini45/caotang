/**
 * The keychain as the page may use it, with each secret's address kept beside it — desktop.md §The keychain.
 *
 * `os-vault.ts` knows how to seal one value, read it back, put it back and remove it. This file is the rule above it: a secret
 * belongs to the address the writer entered it for, and only three calls may change that pairing. `put` stores a key for an
 * address and refuses one already bound elsewhere, so a page cannot point a saved key at an address of its own choosing.
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

import type { KeyBindings } from './key-bindings.js';
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

  /**
   * A write that may change the address, and the undo of both halves. A binding that cannot be made leaves the vault untouched
   * and the undo record as it was; a seal that fails puts the address back, so a key that was not stored never leaves its id
   * pointing somewhere the writer did not enter it for.
   *
   * **The undo record never runs ahead of the vault's.** The vault records its own undo inside `put`, so the address this
   * session remembers for that undo is written only once the binding and the vault's write have both been attempted, and is put
   * back whenever the write fails. A rejected write that left a later address in this map would let `restore` pair an older
   * secret with an address the writer never entered it for.
   */
  const write = (id: string, payload: OsVaultPayload, origin: string, replace: boolean): Promise<void> => serialize(async () => {
    const previous = bindings.originOf(id);
    const recorded = undo.has(id) ? { had: true as const, origin: undo.get(id) } : { had: false as const };
    /** Puts the undo record back the way the vault's own undo still describes it. */
    const restoreRecord = (): void => {
      if (recorded.had) undo.set(id, recorded.origin);
      else undo.delete(id);
    };

    if (!replace) {
      // An id bound elsewhere is refused here, before the vault is touched. The same address is a no-op.
      await bindings.bind(id, origin);
    } else if (previous !== undefined) {
      // A replacement hides the id for the whole write: a request made while the new secret is being sealed is refused, rather
      // than answered with the older secret at the address the writer just moved to. The id is placed again only once the seal
      // holds, and an unplaced key is denied, never sent somewhere.
      await bindings.forget(id);
    }

    undo.set(id, previous);
    try {
      await vault.put(id, payload);
    } catch (error) {
      await setAddress(id, previous);
      restoreRecord();
      throw error;
    }

    if (!replace) return;
    try {
      await bindings.bind(id, origin);
    } catch (error) {
      // The new secret is sealed but its address could not be written: put back the key this replaced and the address it had,
      // so a failed replacement leaves the writer where they were. If even that fails, the id stays hidden and denied.
      try {
        await vault.restore(id);
        undo.delete(id);
        await setAddress(id, previous);
      } catch {
        // Nothing is sent with an id that has no address.
        undo.set(id, previous);
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
      undo.set(id, bindings.originOf(id));
      await vault.putHeaders(id, headers);
    }),

    remove: (id) => serialize(async () => {
      await vault.remove(id);
      // The id is free again: nothing is stored under it, so nothing may be sent with it either.
      await bindings.forget(id);
    }),

    has: (id) => vault.has(id),

    restore: (id) => serialize(async () => {
      // Throws when there is nothing to put back, before anything about the address is touched.
      await vault.restore(id);
      const previous = undo.get(id);
      undo.delete(id);
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
