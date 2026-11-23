/**
 * The hosted instance's storage adapter — [hosted.md §5–§7](docs/architecture/hosted.md). The encrypted adapter, the
 * batched save, the offline queue and the HTTP blob client are built; nothing in the app imports this package yet.
 * The server is the {@link RemoteBlobStore} the caller supplies, or {@link createHttpBlobStore} for the HTTP service.
 */
export {
  EncryptedRemoteArtifactFs,
  type EncryptedRemoteFsOptions,
  type RemoteChange,
} from './encrypted-remote-fs.js';
export {
  BlobPreconditionFailedError,
  RemoteLeaseHeldError,
  RemoteUnavailableError,
  type Precondition,
  type RemoteBlob,
  type RemoteBlobStore,
} from './blob-store.js';
export { createHttpBlobStore, type HttpBlobStoreOptions } from './http-blob-store.js';
export { createHttpLease, type HttpLeaseOptions, type LeaseState, type ProjectLease } from './http-lease.js';
export {
  createHttpProjectRegistry,
  RemoteProjectExistsError,
  RemoteSessionError,
  type HttpProjectRegistryOptions,
  type RemoteProjectRecord,
  type RemoteProjectRegistry,
} from './http-project-records.js';
export { RemoteConflictError, RemoteIntegrityError, RemoteQuotaExceededError } from './errors.js';
export { PendingEdits, replayPending, saveOrQueue, type SaveOutcome } from './pending-edits.js';
