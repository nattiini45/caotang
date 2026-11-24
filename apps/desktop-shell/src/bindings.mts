/**
 * Which address a stored key is for — [desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * A key's destination belongs to the main process, not to the page. The page names a key's id inside a request, and the vault
 * holds the secret; if the page could also say which address that id belongs to, a script in the studio frame could point a
 * key the writer saved at an address of its own and read the answer. So the pairing is recorded here, where a page reaches it
 * only through the two calls that make it: the store that saves a key with the address it was typed for, and the removal that
 * frees the id again.
 *
 * The file is plain JSON beside the vault's sealed record: it holds ids and origins, never a key.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A key that is already bound to another address: the writer has to remove it before it can serve a different provider. */
export class KeyBoundElsewhere extends Error {
  constructor(readonly id: string, readonly origin: string) {
    super(`The key ${id} belongs to ${origin}. Remove it before saving it for another address.`);
  }
}

export interface KeyBindings {
  /** The address this key belongs to, or undefined for an id nothing stored yet. */
  originOf(id: string): string | undefined;
  /** The ids bound to one address: what a request to it may carry. */
  keysFor(origin: string): readonly string[];
  /** Records the address a key belongs to. Refuses an id already bound to a different one. */
  bind(id: string, origin: string): Promise<void>;
  /** Forgets a key's address, so the id is free again once its secret is gone. */
  forget(id: string): Promise<void>;
}

const FILE = 'native-key-bindings.json';
const VERSION = 1;

/** Opens the bindings beside the profile's other state, reading what an earlier run recorded. */
export async function openKeyBindings(directory: string): Promise<KeyBindings> {
  const path = join(directory, FILE);
  const bound = await read(path);
  let writes: Promise<void> = Promise.resolve();

  /** One write at a time: two saves racing would each write the map they read, and the later would drop the earlier. */
  const save = async (): Promise<void> => {
    const text = JSON.stringify({ version: VERSION, bindings: Object.fromEntries(bound) });
    await writeFile(`${path}.tmp`, text, 'utf8');
    await rename(`${path}.tmp`, path);
  };
  const serialize = (work: () => Promise<void>): Promise<void> => {
    const next = writes.then(work);
    writes = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    originOf: (id) => bound.get(id),
    keysFor: (origin) => [...bound].filter(([, value]) => value === origin).map(([id]) => id),
    async bind(id, origin) {
      const held = bound.get(id);
      if (held === origin) return;
      if (held !== undefined) throw new KeyBoundElsewhere(id, held);
      await serialize(async () => {
        bound.set(id, origin);
        await save();
      });
    },
    async forget(id) {
      if (!bound.has(id)) return;
      await serialize(async () => {
        bound.delete(id);
        await save();
      });
    },
  };
}

async function read(path: string): Promise<Map<string, string>> {
  const bound = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return bound;
  }
  // A file that no longer parses reads as empty: every key it named then has no address, and a save records one again, which
  // is the safe direction — a key nothing can send is better than a key sent somewhere a damaged file happened to name.
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
    if (typeof origin === 'string' && /^[A-Za-z][A-Za-z0-9+:.-]*$|^[a-z]+:/u.test(id)) bound.set(id, origin);
  }
  return bound;
}
