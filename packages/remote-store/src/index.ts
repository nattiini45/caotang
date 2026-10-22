/**
 * The hosted instance's storage adapter — [hosted.md §5–§7](docs/architecture/hosted.md). Specified, not built: nothing in
 * the app imports this package, and it holds no network code. The server is the {@link RemoteBlobStore} the caller supplies.
 */
export { EncryptedRemoteArtifactFs, type EncryptedRemoteFsOptions } from './encrypted-remote-fs.js';
export {
  BlobPreconditionFailedError,
  RemoteUnavailableError,
  type Precondition,
  type RemoteBlob,
  type RemoteBlobStore,
} from './blob-store.js';
export { RemoteConflictError, RemoteIntegrityError } from './errors.js';
