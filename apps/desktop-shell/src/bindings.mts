/**
 * Where each stored key's address is kept — [desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * The pairing itself is a rule of the vault and lives in the gateway, where the repository's own gate tests it
 * ([`key-bindings.ts`](../../../packages/gateway/src/keys/key-bindings.ts)). This file is only the file: plain JSON beside the
 * vault's sealed record, holding ids and origins and never a key, written whole every time and read once at start-up.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NodeArtifactFs } from '@caotang/artifact-fs-node';
import { openKeyBindings as openBindings, type KeyBindings } from '@caotang/gateway/keys/key-bindings';

export type { KeyBindings } from '@caotang/gateway/keys/key-bindings';

const FILE = 'native-key-bindings.json';

/** Opens the pairings beside the profile's other state, reading what an earlier run recorded. */
export async function openKeyBindings(directory: string): Promise<KeyBindings> {
  const fs = new NodeArtifactFs(directory);
  const path = join(directory, FILE);
  return openBindings({
    read: async () => await fs.exists(FILE) ? readFile(path, 'utf8') : undefined,
    write: (text) => fs.writeAtomic(FILE, text),
  });
}
