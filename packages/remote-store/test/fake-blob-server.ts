import {
  BlobPreconditionFailedError,
  RemoteUnavailableError,
  type Precondition,
  type RemoteBlob,
  type RemoteBlobStore,
} from '../src/index.js';

interface Version {
  readonly bytes: Uint8Array;
  readonly etag: string;
}

interface StoredObject {
  versions: Version[];
  deleted: boolean;
}

/** What an operator with the whole database and storage could read: every name, and every version ever kept, deleted or not. */
export interface DumpedObject {
  readonly name: string;
  readonly deleted: boolean;
  readonly versions: readonly Uint8Array[];
}

/**
 * An in-memory stand-in for the blob service (hosted.md §6): one project, opaque names, ETags, `If-Match` and
 * `If-None-Match: *`, 412, soft delete. Each {@link FakeBlobServer.client} is one device talking to it.
 */
export class FakeBlobServer {
  readonly #objects = new Map<string, StoredObject>();
  #etags = 0;
  #online = true;

  client(): RemoteBlobStore {
    return {
      get: async (name) => this.#get(name),
      put: async (name, bytes, precondition) => this.#put(name, bytes, precondition),
      delete: async (name) => this.#delete(name),
      list: async () => this.#list(),
    };
  }

  goOffline(): void {
    this.#online = false;
  }

  goOnline(): void {
    this.#online = true;
  }

  dump(): DumpedObject[] {
    return [...this.#objects].map(([name, o]) => ({ name, deleted: o.deleted, versions: o.versions.map((v) => v.bytes.slice()) }));
  }

  /** A hostile server: serve the bytes this name held `back` writes ago, under a fresh etag. */
  replay(name: string, back: number): void {
    const object = this.#objects.get(name);
    const old = object?.versions[object.versions.length - 1 - back];
    if (object === undefined || old === undefined) throw new Error(`no version ${back} writes back for ${name}`);
    object.versions.push({ bytes: old.bytes.slice(), etag: this.#nextEtag() });
  }

  /** A hostile server: serve one name's bytes under another name. */
  swap(name: string, from: string): void {
    const source = this.#objects.get(from)?.versions.at(-1);
    const target = this.#objects.get(name);
    if (source === undefined || target === undefined) throw new Error('unknown name');
    target.versions.push({ bytes: source.bytes.slice(), etag: this.#nextEtag() });
  }

  /** A hostile server: forget an object altogether. */
  drop(name: string): void {
    this.#objects.delete(name);
  }

  #nextEtag(): string {
    this.#etags += 1;
    return `"e${this.#etags}"`;
  }

  #requireOnline(): void {
    if (!this.#online) throw new RemoteUnavailableError();
  }

  #live(name: string): StoredObject | undefined {
    const object = this.#objects.get(name);
    return object === undefined || object.deleted ? undefined : object;
  }

  #get(name: string): RemoteBlob | null {
    this.#requireOnline();
    const current = this.#live(name)?.versions.at(-1);
    return current === undefined ? null : { bytes: current.bytes.slice(), etag: current.etag };
  }

  #put(name: string, bytes: Uint8Array, precondition: Precondition): { etag: string } {
    this.#requireOnline();
    const current = this.#live(name)?.versions.at(-1);
    const holds = 'ifNoneMatch' in precondition ? current === undefined : current?.etag === precondition.ifMatch;
    if (!holds) throw new BlobPreconditionFailedError(name);
    const etag = this.#nextEtag();
    const object = this.#objects.get(name) ?? { versions: [], deleted: false };
    object.versions.push({ bytes: bytes.slice(), etag });
    object.deleted = false;
    this.#objects.set(name, object);
    return { etag };
  }

  #delete(name: string): void {
    this.#requireOnline();
    const object = this.#objects.get(name);
    if (object !== undefined) object.deleted = true;
  }

  #list(): { name: string; etag: string }[] {
    this.#requireOnline();
    const out: { name: string; etag: string }[] = [];
    for (const [name, object] of this.#objects) {
      const current = object.versions.at(-1);
      if (!object.deleted && current !== undefined) out.push({ name, etag: current.etag });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}
