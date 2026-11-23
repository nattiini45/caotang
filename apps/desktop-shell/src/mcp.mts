/**
 * The project's own MCP server, run by this app — [desktop.md §The project's own MCP server].
 *
 * The server is `dist/caotang-mcp.mjs`, the same bundle the `.mcpb` ships, forked as an Electron `utilityProcess` with the open
 * folder as its project. It speaks Streamable HTTP on a loopback port with a token this file mints, so no separate binary is
 * installed and no token is ever typed by the writer.
 *
 * **The app and the server are one coordinated writer.** Both write the same folder, and the server's own lock makes the app ask
 * before it saves. The window both could lose a change in is the instant between the app's digest check and its rename, so the app
 * pauses the server for the length of a save: `pause` posts to the server's `/control/pause`, a write tool is refused while it
 * stands, and `resume` lifts it when the save is done.
 *
 * A folder id, never a path, is what the page names: the grant list every folder channel uses resolves it, so the page cannot point
 * this server at a directory the writer never opened.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { ipcMain, utilityProcess, type UtilityProcess } from 'electron';

import { fromStudioFrame } from './ipc-guard.mjs';
import type { McpHostRefusal, McpHostReply, McpHostStatus } from './mcp-contract.cjs';

/** How long a start waits for the server to say it is ready before the app calls it failed. */
const READY_TIMEOUT_MS = 20_000;

/** How long a pause or a resume may take before the save goes ahead without it. */
const PAUSE_TIMEOUT_MS = 2_000;

const ENDPOINT = /^caotang-mcp: MCP endpoint (http:\/\/127\.0\.0\.1:\d+\/mcp)$/u;

/** What the rest of the main process may ask of this host: the process serving the folder, so the folder channels can tell its lock from another writer's. */
export interface McpHost {
  /** The pid of the running server, or `undefined` when none is running. */
  writerPid(): number | undefined;
}

export interface McpHostOptions {
  readonly entryUrl: string;
  /** The server bundle, absolute. A missing one is a refusal with a sentence, not a crash. */
  readonly bundle: string;
  /** The folder a grant id names, or undefined when the page made it up. */
  readonly rootOf: (id: string) => string | undefined;
}

export function registerMcpIpc(options: McpHostOptions): McpHost {
  let child: UtilityProcess | undefined;
  let status: McpHostStatus = { state: 'stopped' };
  const listeners = new Set<(status: McpHostStatus) => void>();

  const publish = (next: McpHostStatus): void => {
    status = next;
    for (const listener of listeners) listener(next);
  };

  const handle = <T,>(channel: string, run: () => Promise<McpHostReply<T>>): void => {
    ipcMain.handle(`mcp:${channel}`, async (event): Promise<McpHostReply<T>> => {
      if (!fromStudioFrame(event, options.entryUrl)) return { ok: false, refusal: 'no-folder' };
      return run();
    });
  };

  const stopChild = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (running === undefined) return;
    const ended = new Promise<void>((resolve) => running.once('exit', () => resolve()));
    running.kill();
    await ended;
  };

  /** A start: the same bundle, the open folder, a token this app minted, and writes on or off as the writer chose. */
  const start = async (folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => {
    if (typeof folderId !== 'string') return { ok: false, refusal: 'no-folder' };
    const root = options.rootOf(folderId);
    if (root === undefined) return { ok: false, refusal: 'no-folder' };
    if (!existsSync(options.bundle)) return { ok: false, refusal: 'bundle-missing' };
    await stopChild();
    const token = randomBytes(24).toString('base64url');
    publish({ state: 'starting', folderId, allowWrites: allowWrites === true });
    const args = ['serve', '--project', root, '--port', '0'];
    if (allowWrites === true) args.push('--allow-writes');
    const forked = utilityProcess.fork(options.bundle, args, {
      env: { ...process.env, CAOTANG_MCP_TOKEN: token },
      stdio: 'pipe',
      serviceName: 'Caotang MCP server',
    });
    child = forked;

    return await new Promise<McpHostReply<McpHostStatus>>((resolve) => {
      let settled = false;
      let said = '';
      const since = new Date().toISOString();
      const settle = (answer: McpHostReply<McpHostStatus>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        void stopChild();
        publish({ state: 'failed', refusal: 'failed', folderId, detail: said.trim().split('\n').slice(-1)[0] });
        settle({ ok: false, refusal: 'failed' });
      }, READY_TIMEOUT_MS);

      forked.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        said = `${said}${text}`.slice(-4096);
        const endpoint = ENDPOINT.exec(text.split('\n').map((line) => line.trim()).find((line) => ENDPOINT.test(line)) ?? '');
        if (endpoint === null) return;
        const running: McpHostStatus = { state: 'running', url: endpoint[1], token, allowWrites: allowWrites === true, since, folderId };
        publish(running);
        settle({ ok: true, value: running });
      });
      forked.stderr?.on('end', () => {
        if (settled) return;
        publish({ state: 'failed', refusal: 'failed', folderId, detail: said.trim().split('\n').slice(-1)[0] });
        settle({ ok: false, refusal: 'failed' });
      });
      forked.once('exit', () => {
        if (child === forked) child = undefined;
        if (status.state === 'running' || status.state === 'starting') publish({ state: 'stopped' });
        if (!settled) {
          // The server says why it would not serve: a folder another writer holds is the one the writer can act on.
          const locked = /holds the folder's lock|is locked by/u.test(said);
          const refusal: McpHostRefusal = locked ? 'busy' : 'failed';
          publish({ state: 'failed', refusal, folderId, detail: said.trim().split('\n').slice(-1)[0] });
          settle({ ok: false, refusal });
        }
      });
    });
  };

  /** One control call: the app's own token, its own server, and the pause that stands between a check and a rename. */
  const control = async (what: 'pause' | 'resume'): Promise<McpHostReply<McpHostStatus>> => {
    if (status.state !== 'running' || status.url === undefined || status.token === undefined) {
      // Nothing running is not a failure: a save with no server has nothing to pause.
      return { ok: true, value: status };
    }
    const base = status.url.replace(/\/mcp$/u, '');
    try {
      // A server that does not answer must not hold a save: the app's digest check is the guarantee, and this is the window it closes.
      const response = await fetch(`${base}/control/${what}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${status.token}` },
        signal: AbortSignal.timeout(PAUSE_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, refusal: 'failed' };
      return { ok: true, value: status };
    } catch {
      return { ok: false, refusal: 'failed' };
    }
  };

  ipcMain.handle('mcp:start', async (event, folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => (
    fromStudioFrame(event, options.entryUrl) ? await start(folderId, allowWrites) : { ok: false, refusal: 'no-folder' }
  ));
  handle('stop', async () => {
    await stopChild();
    publish({ state: 'stopped' });
    return { ok: true, value: status };
  });
  handle('status', async () => ({ ok: true, value: status }));
  handle('pause', () => control('pause'));
  handle('resume', () => control('resume'));

  ipcMain.removeAllListeners('mcp:subscribe');
  ipcMain.on('mcp:subscribe', (event) => {
    if (!fromStudioFrame(event, options.entryUrl)) return;
    const listener = (next: McpHostStatus): void => {
      if (!event.sender.isDestroyed()) event.sender.send('mcp:status', next);
    };
    listeners.add(listener);
    event.sender.once('destroyed', () => listeners.delete(listener));
  });

  return { writerPid: () => child?.pid };
}
