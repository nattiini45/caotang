/**
 * The server as the client sees it — [hosted.md §6](docs/architecture/hosted.md). A blob store for one project that holds
 * opaque bytes under opaque names and nothing else. An HTTP client for it is Phase 2 work; this package ships none.
 */

export interface RemoteBlob {
  readonly bytes: Uint8Array;
  readonly etag: string;
}

/** `If-Match: <etag>` (replace exactly that version) or `If-None-Match: *` (create, and nothing else). */
export type Precondition = { readonly ifMatch: string } | { readonly ifNoneMatch: '*' };

export interface RemoteBlobStore {
  /** `null` when the name is absent or soft-deleted. */
  get(name: string): Promise<RemoteBlob | null>;
  /** Throws {@link BlobPreconditionFailedError} (HTTP 412) when the precondition does not hold; nothing is written then. */
  put(name: string, bytes: Uint8Array, precondition: Precondition): Promise<{ readonly etag: string }>;
  /** Soft delete: the server keeps the bytes for its retention window. A no-op for an absent name. */
  delete(name: string): Promise<void>;
  /** Live names and their etags. */
  list(): Promise<{ readonly name: string; readonly etag: string }[]>;
}

/** HTTP 412: another writer got there first. */
export class BlobPreconditionFailedError extends Error {
  constructor(readonly blob: string) {
    super(`the server refused the write to ${blob}: it changed since it was read`);
    this.name = 'BlobPreconditionFailedError';
  }
}

/** The server could not be reached. Nothing was written. */
export class RemoteUnavailableError extends Error {
  constructor(message = 'the server could not be reached') {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}
