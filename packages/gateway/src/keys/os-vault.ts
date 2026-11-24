/**
 * The keychain, sealed by the operating system, with each secret's address inside the same record — desktop.md §The keychain.
 *
 * The host supplies three things and this file supplies the rest: where the vault's bytes live, how one value is sealed and
 * opened, and whether there is a keychain at all. Everything that can go wrong with a vault is decided here, and tested here:
 * a file that will not parse costs its keys and never the window, a write is read back before it is reported, a replace can be
 * put back, and writes are serialised so two saves cannot each write the entries they read.
 *
 * **A key and its address are one entry, committed in one write.** Each entry is the sealed payload and the address the writer
 * entered it for, and every change is a single write of the whole file: a first save, a replacement that moves the address, a
 * headers edit that keeps it, a removal, an undo. So a key is never stored without its address and never has an address without
 * its key — there is no moment between two writes in which one exists without the other, and nothing has to be put back after a
 * failure. The undo names the entry a write replaced, secret and address together, so a restore can only ever hand back a pair
 * that was stored as a pair (#864).
 *
 * The address is a bare origin (`key-origin.ts`): plain text beside the sealed value, never a secret, and checked against the
 * same rule a save goes through. A key stored before addresses existed carries none, and an id with no address is denied at every
 * origin until the writer enters the key again for the one they mean.
 *
 * The format is one file of entries, keyed by a vault id (`prv_…` for a provider profile, `mcp:…` for a server's token). A
 * secret never leaves this module except through {@link OsKeyVault.read} and {@link OsKeyVault.readFor}, which the host calls
 * for a request it is about to send.
 */

import { keyOrigin } from './key-origin.js';

/** What one key is: the secret, and the extra header values a generic endpoint sends beside it. */
export interface OsVaultPayload {
  readonly apiKey: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

/** A key that is already stored for another address: the writer has to enter it again for the one they are moving it to. */
export class KeyBoundElsewhere extends Error {
  constructor(readonly id: string, readonly origin: string) {
    super(`The key ${id} belongs to ${origin}. Enter it again to store it for another address.`);
  }
}

/** What one vault id holds, without the secret: nothing, a key, or headers alone with an empty key (#868). */
export type OsVaultKeyState = 'none' | 'empty' | 'key';

export interface OsKeyVault {
  /** Whether the operating system's keychain is usable on this machine. */
  available(): Promise<boolean>;
  /** The payload stored under `id`. The host only: no channel exposes this to the page. */
  read(id: string): Promise<OsVaultPayload | undefined>;
  /** The address `id` is stored for, or undefined for an id nothing has placed. */
  originOf(id: string): string | undefined;
  /** The ids stored for one address: what a request to it may carry. */
  keysFor(origin: string): readonly string[];
  /** Stores a payload for one address, refusing an id already stored for another. */
  put(id: string, payload: OsVaultPayload, origin: string): Promise<void>;
  /** Stores the key a writer typed again for a changed endpoint, and moves the id's address with it. */
  putReplacement(id: string, payload: OsVaultPayload, origin: string): Promise<void>;
  /** Replaces the extra headers of a stored key, and keeps its key and its address. */
  putHeaders(id: string, headers: Readonly<Record<string, string>>): Promise<void>;
  /** Drops the key and its address, and the undo that could have put them back. */
  remove(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
  /** Puts back the entry the last write for `id` replaced, its address included. */
  restore(id: string): Promise<void>;
  /** A digest of what is stored, so a caller can tell one save from the next without reading it. */
  revision(id: string): Promise<string>;
  /** The extra header values stored with `id`, and nothing else: what the page may know about a stored key. */
  headers(id: string): Promise<Readonly<Record<string, string>> | undefined>;
  /**
   * The secrets for a request to `origin`, read in the same turn a write takes. Undefined when an id is not stored for this
   * address, or holds nothing: a secret is only ever handed over for the address it belongs to at the moment it is read.
   */
  readFor(origin: string, ids: readonly string[]): Promise<ReadonlyMap<string, OsVaultPayload> | undefined>;
  /**
   * Whether `id` holds nothing, a key, or headers alone with an empty key. Never the key, and never anything about it: the page
   * needs the difference to answer a revealed payload with the empty key rather than a handle.
   */
  keyState(id: string): Promise<OsVaultKeyState>;
}

/** What the host brings: the file, the seal, and the answer to whether there is a keychain at all. */
export interface OsVaultHost {
  /** The vault's text, or undefined when nothing has been stored yet. */
  read(): Promise<string | undefined>;
  /** Writes the vault's text, the way the host writes every other artifact: temp, fsync, rename. */
  write(text: string): Promise<void>;
  available(): Promise<boolean>;
  /** Seals one payload into text the host can store. Throws when it cannot. */
  seal(plain: string): Promise<string>;
  /** Opens one sealed value. Throws when it cannot. */
  open(sealed: string): Promise<string>;
}

/**
 * Whether what was read back is what was written: the key, and every extra header value beside it. A dropped or reordered header
 * would otherwise pass as stored and fail on the first call that needed it.
 */
function samePayload(read: OsVaultPayload | undefined, written: OsVaultPayload): boolean {
  if (read === undefined || read.apiKey !== written.apiKey) return false;
  const expected = Object.entries(written.customHeaders ?? {});
  const found = Object.entries(read.customHeaders ?? {});
  if (expected.length !== found.length) return false;
  return expected.every(([name, value]) => read.customHeaders?.[name] === value);
}

/** A vault id: a provider profile id, or an `mcp:` reference. Never a secret, and never a path. */
export const VAULT_ID = /^[A-Za-z0-9:_.-]{1,128}$/u;

/** One stored key: the sealed payload, and the address it was entered for. */
interface Entry {
  readonly sealed: string;
  readonly origin?: string;
}

/** Version 1 held the sealed text alone: a key stored then has no address, and stays denied until it is entered again. */
const VERSION = 2;

/** One entry as it was stored: the sealed text, or the sealed text and its address. */
function entryOf(raw: unknown): Entry | undefined {
  if (typeof raw === 'string') return { sealed: raw };
  if (raw === null || typeof raw !== 'object') return undefined;
  const candidate = raw as { sealed?: unknown; origin?: unknown };
  if (typeof candidate.sealed !== 'string') return undefined;
  const origin = typeof candidate.origin === 'string' ? keyOrigin(candidate.origin) : undefined;
  // An address that is not one a key may belong to is no address: the key stays stored and is denied rather than sent anywhere.
  return origin === undefined ? { sealed: candidate.sealed } : { sealed: candidate.sealed, origin };
}

function parse(bytes: string): Record<string, Entry> {
  let saved: unknown;
  try {
    saved = JSON.parse(bytes);
  } catch {
    return {};
  }
  if (saved === null || typeof saved !== 'object') return {};
  const file = saved as { version?: unknown; entries?: unknown };
  if ((file.version !== 1 && file.version !== VERSION) || file.entries === null || typeof file.entries !== 'object') return {};
  const entries: Record<string, Entry> = {};
  for (const [id, raw] of Object.entries(file.entries as Record<string, unknown>)) {
    if (!VAULT_ID.test(id)) continue;
    const entry = entryOf(raw);
    if (entry !== undefined) entries[id] = entry;
  }
  return entries;
}

export async function openOsVault(host: OsVaultHost): Promise<OsKeyVault> {
  const text = await host.read();
  let entries: Record<string, Entry> = text === undefined ? {} : parse(text);
  let writes = Promise.resolve();
  /** The entry the last write of an id replaced, so a caller that cannot read a key can still undo a write it decided against. */
  const undo = new Map<string, Entry | undefined>();

  const open = async (id: string): Promise<OsVaultPayload | undefined> => {
    const sealed = entries[id]?.sealed;
    if (sealed === undefined || !await host.available()) return undefined;
    try {
      const payload: unknown = JSON.parse(await host.open(sealed));
      if (payload === null || typeof payload !== 'object') return undefined;
      const candidate = payload as { apiKey?: unknown; customHeaders?: unknown };
      if (typeof candidate.apiKey !== 'string') return undefined;
      const headers = candidate.customHeaders;
      return {
        apiKey: candidate.apiKey,
        ...(headers === null || typeof headers !== 'object' ? {} : { customHeaders: { ...headers as Record<string, string> } }),
      };
    } catch {
      // A value this machine cannot open is a value this machine cannot open: the profile is named as one without a key rather
      // than the app failing to start.
      return undefined;
    }
  };

  /** One write at a time: two saves racing would each write the entries they read, and the later one would drop the earlier. */
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const pending = writes.then(work);
    writes = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const write = async (next: Record<string, Entry>): Promise<void> => {
    await host.write(JSON.stringify({ version: VERSION, entries: next }));
    entries = next;
  };

  /** The address a save is for: the one rule a stored key's destination goes through, on the way in as well as on the way out. */
  const addressOf = (raw: string): string => {
    const origin = keyOrigin(raw);
    if (origin === undefined) throw new Error(`The address ${raw} is not one a key may be stored for.`);
    return origin;
  };

  /** The write itself, without the queue: only a caller that already holds the queue may use this. */
  const store = async (id: string, payload: OsVaultPayload, origin: string | undefined): Promise<void> => {
    if (!await host.available()) throw new Error('The operating system keychain is not available.');
    const before = entries;
    // The undo is the entry this write replaces — secret and address together — so nothing a restore puts back can pair one
    // write's secret with another write's address, and a write that fails has nothing of its own to put back.
    undo.set(id, before[id]);
    const sealed = await host.seal(JSON.stringify(payload));
    const next = { ...before, [id]: origin === undefined ? { sealed } : { sealed, origin } };
    // One write of the whole record: the sealed value and its address reach the disk in the same turn, or neither does.
    await write(next);
    // A key is stored when it can be read back, not when the file said so: reading it again is the one operation that proves
    // the seal, the file and the opener all work for what was just written, and a failure puts the earlier file back.
    const match = await open(id);
    if (!samePayload(match, payload)) {
      await write(before);
      throw new Error('The key did not survive being stored, so it was not kept.');
    }
  };

  return {
    available: () => host.available(),

    read: open,

    originOf: (id) => entries[id]?.origin,

    keysFor: (origin) => Object.entries(entries).filter(([, entry]) => entry.origin === origin).map(([id]) => id),

    /**
     * The one write that refuses to move a key: an id already stored for another address is answered with that address rather
     * than rebound, so no page can point a saved key at an endpoint of its own choosing. A key with no address — one stored
     * before addresses were kept — is placed by this call, because it carries the secret the writer entered for it.
     */
    put: (id, payload, origin) => serialize(async () => {
      const address = addressOf(origin);
      const held = entries[id]?.origin;
      if (held !== undefined && held !== address) throw new KeyBoundElsewhere(id, held);
      await store(id, payload, address);
    }),

    /** The writer's own key, typed again for an endpoint they moved: the one write that takes a new address with it. */
    putReplacement: (id, payload, origin) => serialize(() => store(id, payload, addressOf(origin))),

    /**
     * The extra headers of a stored key, replaced with the key and the address kept: what a headers-only edit does. A key that
     * is not stored is not created by this — there is no secret to keep — and an entry with no address keeps having none.
     */
    putHeaders: (id, headers) => serialize(async () => {
      const payload = await open(id);
      if (payload === undefined) return;
      await store(id, { apiKey: payload.apiKey, ...(Object.keys(headers).length === 0 ? {} : { customHeaders: { ...headers } }) }, entries[id]?.origin);
    }),

    async remove(id) {
      if (entries[id] === undefined) return;
      await serialize(async () => {
        if (entries[id] === undefined) return;
        const next = { ...entries };
        delete next[id];
        await write(next);
        // A removal is final: an undo outliving the entry it named could put the secret back with no address beside it, and
        // reading that back is the one thing no restore may do.
        undo.delete(id);
      });
    },

    async has(id) {
      return entries[id] !== undefined;
    },

    async restore(id) {
      if (!undo.has(id)) throw new Error('There is nothing to put back for this key.');
      const previous = undo.get(id);
      undo.delete(id);
      await serialize(async () => {
        const next = { ...entries };
        if (previous === undefined) delete next[id];
        else next[id] = previous;
        // The entry went in as a pair, so it comes back as one: the secret and the address it was stored for.
        await write(next);
      });
    },

    async revision(id) {
      const sealed = entries[id]?.sealed;
      if (sealed === undefined) return 'empty';
      // A digest of what is stored, not of the secret: the same key stored twice is two revisions, and the digest says nothing
      // about the key to anyone who reads it.
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealed));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    },

    async headers(id) {
      const payload = await open(id);
      if (payload === undefined) return undefined;
      return payload.customHeaders ?? {};
    },

    readFor: (origin, ids) => serialize(async () => {
      const secrets = new Map<string, OsVaultPayload>();
      for (const id of ids) {
        // The address is the entry's own, read in the same turn as the secret: a key is only ever handed over for the address
        // it is stored for at this moment.
        if (entries[id]?.origin !== origin) return undefined;
        const payload = await open(id);
        if (payload === undefined) return undefined;
        secrets.set(id, payload);
      }
      return secrets;
    }),

    async keyState(id) {
      const payload = await open(id);
      if (payload === undefined) return 'none';
      return payload.apiKey === '' ? 'empty' : 'key';
    },
  };
}
