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
}

export interface DesktopBridge {
  readonly version: 2;
  readonly folders: NativeFolderBridge;
}

declare global {
  interface Window {
    readonly caotangDesktop?: DesktopBridge;
  }
}
