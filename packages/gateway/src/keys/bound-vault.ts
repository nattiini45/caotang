/**
 * The keychain as the page may use it, with each secret's address kept beside it — desktop.md §The keychain.
 *
 * `os-vault.ts` knows how to seal one value, read it back, put it back and remove it. This file is the rule above it: a secret
 * belongs to the address the writer entered it for, and only four calls may change that pairing. `put` stores a key for an
 * address and refuses one already bound elsewhere, so a page cannot point a saved key at an address of its own choosing.
 * `putReplacement` is the writer's own key typed again for an endpoint they changed, which takes the new address with it.
 * `remove` frees the id. `bind` fills the missing address of a key stored before these pairings existed, and nothing else.
 *
 * **A write and its undo carry the address too.** A `put` or a headers edit remembers the address that id had before it, so
 * `restore` puts back the secret and the address together: a page may undo a write it decided against, and cannot undo its way
 * into sending an older secret to an address the writer never entered it for (#864).
 */

import type { KeyBindings } from './key-bindings.js';
import type { OsKeyVault, OsVaultPayload } from './os-vault.js';

export interface BoundKeyVault {
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
  /** Gives a key the vault already holds and that has no address yet the one its profile names. Answers whether it bound it. */
  bind(id: string, origin: string): Promise<boolean>;
}

export function openBoundKeyVault(vault: OsKeyVault, bindings: KeyBindings): BoundKeyVault {
  let writes: Promise<unknown> = Promise.resolve();
  /** The address each id had before the write that can still be undone, `undefined` when it had none. */
  const undo = new Map<string, string | undefined>();

  /** One change at a time, so the sealed entry and its address move together however many calls arrive at once. */
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
   * A write that may change the address, and the undo of both halves. A binding that cannot be made leaves the vault
   * untouched; a seal that fails puts the address back, so a key that was not stored never leaves its id pointing somewhere
   * the writer did not enter it for. The undo record stays, because it is the state the vault's own undo returns to.
   */
  const write = (id: string, payload: OsVaultPayload, origin: string, replace: boolean): Promise<void> => serialize(async () => {
    const previous = bindings.originOf(id);
    await (replace ? bindings.rebind(id, origin) : bindings.bind(id, origin));
    undo.set(id, previous);
    try {
      await vault.put(id, payload);
    } catch (error) {
      await setAddress(id, previous);
      throw error;
    }
  });

  return {
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

    bind: (id, origin) => serialize(async () => {
      // Only a secret the vault holds, and only one nothing has placed yet: this is the upgrade for keys stored before the
      // pairings existed, never a way to move a key.
      if (!await vault.has(id) || bindings.originOf(id) !== undefined) return false;
      await bindings.bind(id, origin);
      return true;
    }),
  };
}
