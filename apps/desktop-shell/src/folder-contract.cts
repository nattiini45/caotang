import type { NativeEgressBridge } from './egress-contract.cjs';
import type { DesktopMcpBridge } from './mcp-contract.cjs';
import type { NativeOsBridge } from './os-contract.cjs';
import type { KeyVaultBridge } from './vault-contract.cjs';

export interface NativeFolder {
  readonly id: string;
  readonly name: string;
}

export interface NativeFolderEntry {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

export type FolderReply<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly error: 'missing' | 'entry-missing' | 'read-only' | 'invalid' | 'unavailable';
};

/** A burst of changes another program made in an open project folder: the folder's id and project-relative paths. */
export interface NativeFolderChange {
  readonly folderId: string;
  readonly paths: readonly string[];
}

export interface NativeFolderBridge {
  pickFolder(mode: 'open' | 'empty'): Promise<FolderReply<NativeFolder | null>>;
  recentFolders(): Promise<FolderReply<readonly NativeFolder[]>>;
  rememberFolder(id: string): Promise<FolderReply<null>>;
  forgetFolder(id: string): Promise<FolderReply<null>>;
  list(id: string, path: string): Promise<FolderReply<readonly NativeFolderEntry[]>>;
  read(id: string, path: string): Promise<FolderReply<Uint8Array>>;
  write(id: string, path: string, bytes: Uint8Array): Promise<FolderReply<null>>;
  mkdir(id: string, path: string): Promise<FolderReply<null>>;
  remove(id: string, path: string): Promise<FolderReply<null>>;
  watch(id: string): Promise<FolderReply<string>>;
  unwatch(subscription: string): Promise<FolderReply<null>>;
  onChanged(listener: (change: NativeFolderChange) => void): () => void;
}

/**
 * Everything the desktop shell exposes to the studio. `folders` arrived with version 2, `os` and the provider port with version 3,
 * the vault with 4, the project's own server with 5 and, with 6, the address a key is stored for and whether it holds a key: a
 * page reads the version before it reads a member, so an older shell and a newer studio each see only what both have.
 */

export interface DesktopBridge {
  readonly version: 6;
  readonly folders: NativeFolderBridge;
  readonly os: NativeOsBridge;
  /** Provider and MCP calls made by the main process, where no CORS preflight applies. */
  readonly net: NativeEgressBridge;
  /** The operating system's keychain: a page may store, remove and ask, never read. */
  readonly vault: KeyVaultBridge;
  /** The project's own MCP server, run by this app, and the pause that keeps the two writers apart. */
  readonly mcp: DesktopMcpBridge;
}

declare global {
  interface Window {
    readonly caotangDesktop?: DesktopBridge;
  }
}
