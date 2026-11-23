/**
 * The project's own MCP server, from the page's side — the desktop app asks the main process to serve the open folder over MCP,
 * shows the writer where it is, and pauses it for the length of a save so the two writers cannot replace each other's change
 * ([desktop.md](../../../docs/architecture/desktop.md#the-projects-own-mcp-server-406)).
 *
 * The browser build has no server of its own: every call here answers "nothing to serve" there, and no interface shows the block.
 * The token never enters a project, an export or a log; it exists so the writer can paste it into the program they use as a host.
 */

import type { McpHostStatus } from '../../../desktop-shell/src/mcp-contract.cjs';

export type { McpHostRefusal, McpHostState, McpHostStatus } from '../../../desktop-shell/src/mcp-contract.cjs';

function bridge(): NonNullable<Window['caotangDesktop']>['mcp'] | undefined {
  if (typeof window === 'undefined') return undefined;
  const desktop = window.caotangDesktop;
  return desktop !== undefined && desktop.version >= 5 ? desktop.mcp : undefined;
}

/** Whether this build can serve the open folder over MCP. The interface says so where it matters, and nowhere else. */
export function projectServerAvailable(): boolean {
  return bridge() !== undefined;
}

/** The server as it stands: stopped, starting, running with its address, or failed with the reason. */
export async function projectServerStatus(): Promise<McpHostStatus | undefined> {
  const mcp = bridge();
  if (mcp === undefined) return undefined;
  const reply = await mcp.status();
  return reply.ok ? reply.value : { state: 'failed', refusal: reply.refusal };
}

export async function startProjectServer(folderId: string, allowWrites: boolean): Promise<McpHostStatus | undefined> {
  const mcp = bridge();
  if (mcp === undefined) return undefined;
  const reply = await mcp.start(folderId, allowWrites);
  return reply.ok ? reply.value : { state: 'failed', refusal: reply.refusal };
}

export async function stopProjectServer(): Promise<McpHostStatus | undefined> {
  const mcp = bridge();
  if (mcp === undefined) return undefined;
  const reply = await mcp.stop();
  return reply.ok ? reply.value : { state: 'failed', refusal: reply.refusal };
}

/** Watches the server's state: a start, a death, a stop. */
export function subscribeProjectServer(listener: (status: McpHostStatus) => void): () => void {
  const mcp = bridge();
  return mcp === undefined ? () => undefined : mcp.onStatus(listener);
}

/**
 * Whether the folder's `.caotang-mcp.lock` is this app's own server's: the server that holds a folder is the one serving that folder,
 * and this app pauses it around its saves, so its lock is not another writer's (lifecycle `writeFolder`). A lock any other server left
 * — one a terminal started — still counts as another writer. False without a bridge, so the browser build asks nothing.
 */
export async function projectServerHoldsFolder(folderId: string | undefined): Promise<boolean> {
  if (folderId === undefined || bridge() === undefined) return false;
  const status = await projectServerStatus().catch(() => undefined);
  return status?.state === 'running' && status.folderId === folderId;
}

/**
 * Runs a save with the server paused, so no write tool starts while the app's own files are being checked and renamed. A server
 * that is not running, or a pause that fails, does not fail the save: the app's digest check is the guarantee, and this is the
 * window it closes.
 */
export async function withProjectServerPaused<T>(save: () => Promise<T>): Promise<T> {
  const mcp = bridge();
  if (mcp === undefined) return await save();
  await mcp.pause().catch(() => undefined);
  try {
    return await save();
  } finally {
    await mcp.resume().catch(() => undefined);
  }
}

/**
 * What the writer pastes into the host they use, for a server on this computer. The shape is the one an MCP host reads in its
 * configuration file: a name, the address, and the token as a header.
 */
export function projectServerConfig(server: McpHostStatus): string {
  return JSON.stringify(
    { mcpServers: { caotang: { type: 'http', url: server.url ?? '', headers: { Authorization: `Bearer ${server.token ?? ''}` } } } },
    null,
    2,
  );
}
