/**
 * A vault sealed by the operating system — desktop.md §The keychain.
 *
 * The host supplies three things and this file supplies the rest: where the vault's bytes live, how one value is sealed and
 * opened, and whether there is a keychain at all. Everything that can go wrong with a vault is decided here, and tested here:
 * a file that will not parse costs its keys and never the window, a write is read back before it is reported, a replace can be
 * put back, and writes are serialised so two saves cannot each write the entries they read.
 *
 * The format is one file of sealed entries, keyed by a vault id (`prv_…` for a provider profile, `mcp:…` for a server's
 * token). A secret never leaves this module except through {@link OsKeyVault.read}, which the host calls for a request it is
 * about to send.
 */

/** What one key is: the secret, and the extra header values a generic endpoint sends beside it. */
export interface OsVaultPayload {
  readonly apiKey: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface OsKeyVault {
  /** Whether the operating system's keychain is usable on this machine. */
  available(): Promise<boolean>;
  /** The payload stored under `id`. The host only: no channel exposes this to the page. */
  read(id: string): Promise<OsVaultPayload | undefined>;
  /** Stores a payload, and answers once it has been read back and matched. */
  put(id: string, payload: OsVaultPayload): Promise<void>;
  /** Replaces the extra headers of a stored key and keeps its key: what a headers-only edit does (#863). */
  putHeaders(id: string, headers: Readonly<Record<string, string>>): Promise<void>;
  remove(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
  /** Puts back what the last `put` for `id` replaced, and removes the entry when there was none. */
  restore(id: string): Promise<void>;
  /** A digest of what is stored, so a caller can tell one save from the next without reading it. */
  revision(id: string): Promise<string>;
  /** The extra header values stored with `id`, and nothing else: what the page may know about a stored key. */
  headers(id: string): Promise<Readonly<Record<string, string>> | undefined>;
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

const VERSION = 1;

function parse(bytes: string): Record<string, string> {
  let saved: unknown;
  try {
    saved = JSON.parse(bytes);
  } catch {
    return {};
  }
  if (saved === null || typeof saved !== 'object') return {};
  const file = saved as { version?: unknown; entries?: unknown };
  if (file.version !== VERSION || file.entries === null || typeof file.entries !== 'object') return {};
  const entries: Record<string, string> = {};
  for (const [id, sealed] of Object.entries(file.entries as Record<string, unknown>)) {
    if (typeof sealed === 'string' && VAULT_ID.test(id)) entries[id] = sealed;
  }
  return entries;
}

export async function openOsVault(host: OsVaultHost): Promise<OsKeyVault> {
  const text = await host.read();
  let entries: Record<string, string> = text === undefined ? {} : parse(text);
  let writes = Promise.resolve();
  /** What the last put of an id replaced, so a caller that cannot read a key can still undo a write it decided against. */
  const undo = new Map<string, string | undefined>();

  const open = async (id: string): Promise<OsVaultPayload | undefined> => {
    const sealed = entries[id];
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

  const write = async (next: Record<string, string>): Promise<void> => {
    await host.write(JSON.stringify({ version: VERSION, entries: next }));
    entries = next;
  };

  /** The write itself, without the queue: only a caller that already holds the queue may use this. */
  const store = async (id: string, payload: OsVaultPayload): Promise<void> => {
    if (!await host.available()) throw new Error('The operating system keychain is not available.');
    const sealed = await host.seal(JSON.stringify(payload));
    const before = entries;
    const previous = undo.has(id) ? { had: true as const, value: undo.get(id) } : { had: false as const };
    /** A write that did not happen leaves the undo describing the last one that did. */
    const restoreUndo = (): void => {
      if (previous.had) undo.set(id, previous.value);
      else undo.delete(id);
    };
    undo.set(id, before[id]);
    try {
      await write({ ...before, [id]: sealed });
      // A key is stored when it can be read back, not when the file said so: reading it again is the one operation that proves
      // the seal, the file and the opener all work for what was just written, and a failure puts the earlier file back.
      const match = await open(id);
      if (!samePayload(match, payload)) {
        await write(before);
        throw new Error('The key did not survive being stored, so it was not kept.');
      }
    } catch (error) {
      // A caller that pairs each stored key with an address keeps its own record of what this undo names; a failed write that
      // left a new undo entry behind would let the two disagree about the address of the secret it would put back.
      restoreUndo();
      throw error;
    }
  };

  const put = (id: string, payload: OsVaultPayload): Promise<void> => serialize(() => store(id, payload));

  return {
    available: () => host.available(),

    read: open,

    put,

    /**
     * The extra headers of a stored key, replaced with the key kept: the caller read the payload (and so was given a handle) and
     * changed nothing else. A key that is not stored is not created by this — there is no secret to keep, and writing headers
     * alone would leave an entry with a handle for a key.
     */
    async putHeaders(id, headers) {
      // The read and the write are one turn. Reading outside the queue and writing inside it would let a key stored in between be
      // overwritten by the older payload this read saw, which is the same replace-a-secret mistake the caller is avoiding.
      await serialize(async () => {
        const payload = await open(id);
        if (payload === undefined) return;
        await store(id, { apiKey: payload.apiKey, ...(Object.keys(headers).length === 0 ? {} : { customHeaders: { ...headers } }) });
      });
    },

    async remove(id) {
      if (entries[id] === undefined) return;
      await serialize(async () => {
        if (entries[id] === undefined) return;
        const next = { ...entries };
        delete next[id];
        await write(next);
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
        await write(next);
      });
    },

    async revision(id) {
      const sealed = entries[id];
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
  };
}
