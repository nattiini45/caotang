/**
 * What the page may ask of the project's own MCP server, and what it gets back — [desktop.md §The project's own MCP server].
 *
 * The page starts and stops the server that serves the open folder, reads what a host needs to reach it, and asks it to pause
 * while the app saves. It never reads a token of someone else's server, and it never chooses a folder by path: a folder id is
 * resolved by the shell's own grant list, the same one every folder channel uses.
 */

/** Where the server of this app is in its life. */
export type McpHostState = 'stopped' | 'starting' | 'running' | 'failed';

/** Why a start did not reach running, in words the page turns into a sentence. */
export type McpHostRefusal = 'bundle-missing' | 'no-folder' | 'no-keychain' | 'busy' | 'failed';

export interface McpHostStatus {
  readonly state: McpHostState;
  /** The endpoint a host is pointed at, e.g. `http://127.0.0.1:7433/mcp`. Absent unless running. */
  readonly url?: string;
  /**
   * The bearer token this app minted for that server. It is in the bridge because the writer copies it into another program's
   * configuration, which is the whole reason the server exists; it is not a provider key and it is never written into a project.
   */
  readonly token?: string;
  /** Whether external callers may change the project. */
  readonly allowWrites?: boolean;
  /** When the current run started, as an ISO instant. */
  readonly since?: string;
  /** The folder the run serves, as the page knows it. */
  readonly folderId?: string;
  /** Why the server is not running, when it is `failed`. */
  readonly refusal?: McpHostRefusal;
  /** One sentence from the server itself, when it refused or died; the page shows it as it came. */
  readonly detail?: string;
}

export type McpHostReply<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly refusal: McpHostRefusal;
  /** The server's own sentence, when it has one the page should show instead of its default wording. */
  readonly detail?: string;
};

/** The `mcp` namespace the preload exposes. */
export interface DesktopMcpBridge {
  start(folderId: string, allowWrites: boolean): Promise<McpHostReply<McpHostStatus>>;
  stop(): Promise<McpHostReply<McpHostStatus>>;
  status(): Promise<McpHostReply<McpHostStatus>>;
  /** Stops a write from starting, for as long as the app is saving. Idempotent, so two nested saves are one pause. */
  pause(): Promise<McpHostReply<McpHostStatus>>;
  resume(): Promise<McpHostReply<McpHostStatus>>;
  onStatus(listener: (status: McpHostStatus) => void): () => void;
}
