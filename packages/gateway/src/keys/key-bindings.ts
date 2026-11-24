/**
 * Which address a stored key belongs to — [desktop.md §The keychain](../../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * A key's destination belongs to the main process, not to the page. The page names a key's id inside a request, and the vault
 * holds the secret; if the page could also say which address that id belongs to, a script in the studio frame could point a
 * key the writer saved at an address of its own and read the answer. So the pairing is recorded here, where a page reaches it
 * only through the calls that make it: the store that saves a key with the address it was typed for, the removal that frees
 * the id again, the replacement key a writer types for a changed endpoint, and the upgrade that gives a key stored before
 * these pairings existed its profile's own address (#864).
 *
 * The file these rules are kept in is plain JSON beside the vault's sealed record: it holds ids and origins, never a key.
 */

import { VAULT_ID } from './os-vault.js';

/** A key that is already bound to another address: the writer has to enter it again for the one they are moving it to. */
export class KeyBoundElsewhere extends Error {
  constructor(readonly id: string, readonly origin: string) {
    super(`The key ${id} belongs to ${origin}. Enter it again to store it for another address.`);
  }
}

export interface KeyBindings {
  /** The address this key belongs to, or undefined for an id nothing stored yet. */
  originOf(id: string): string | undefined;
  /** The ids bound to one address: what a request to it may carry. */
  keysFor(origin: string): readonly string[];
  /** Records the address a key belongs to. Refuses an id already bound to a different one. */
  bind(id: string, origin: string): Promise<void>;
  /** Records a new address for an id: the one move a writer's own replacement key makes, and the one an undo puts back. */
  rebind(id: string, origin: string): Promise<void>;
  /** Forgets a key's address, so the id is free again once its secret is gone. */
  forget(id: string): Promise<void>;
}

/** Where the pairings are kept: one text, read once and written whole. */
export interface KeyBindingsHost {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

const VERSION = 1;

/** Opens the pairings an earlier run recorded. A file that will not parse reads as empty, which denies every key it named. */
export async function openKeyBindings(host: KeyBindingsHost): Promise<KeyBindings> {
  const bound = parse(await host.read());
  let writes: Promise<unknown> = Promise.resolve();

  /** One write at a time: two saves racing would each write the map they read, and the later would drop the earlier. */
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const pending = writes.then(work);
    writes = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const save = (): Promise<void> => host.write(JSON.stringify({ version: VERSION, bindings: Object.fromEntries(bound) }));

  return {
    originOf: (id) => bound.get(id),
    keysFor: (origin) => [...bound].filter(([, value]) => value === origin).map(([id]) => id),
    bind: (id, origin) => serialize(async () => {
      const held = bound.get(id);
      if (held === origin) return;
      if (held !== undefined) throw new KeyBoundElsewhere(id, held);
      bound.set(id, origin);
      await save();
    }),
    rebind: (id, origin) => serialize(async () => {
      if (bound.get(id) === origin) return;
      bound.set(id, origin);
      await save();
    }),
    forget: (id) => serialize(async () => {
      if (!bound.has(id)) return;
      bound.delete(id);
      await save();
    }),
  };
}

function parse(text: string | undefined): Map<string, string> {
  const bound = new Map<string, string>();
  if (text === undefined) return bound;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bound;
  }
  if (parsed === null || typeof parsed !== 'object') return bound;
  const record = parsed as { version?: unknown; bindings?: unknown };
  if (record.version !== VERSION || record.bindings === null || typeof record.bindings !== 'object') return bound;
  for (const [id, origin] of Object.entries(record.bindings as Record<string, unknown>)) {
    if (VAULT_ID.test(id) && typeof origin === 'string' && origin !== '') bound.set(id, origin);
  }
  return bound;
}
