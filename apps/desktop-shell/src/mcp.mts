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

/** What the block says when the server had to be restarted because it did not answer the resume that ends a save. */
export const RESTARTED_AFTER_RESUME = 'The server did not answer while Caotang finished saving, so it was stopped. Start it again.';

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
  /** Each page that is listening, with what it is told: one entry per page, however many times its component mounts. */
  const listeners = new Map<number, (status: McpHostStatus) => void>();

  const publish = (next: McpHostStatus): void => {
    status = next;
    for (const listener of listeners.values()) listener(next);
  };

  const handle = <T,>(channel: string, run: () => Promise<McpHostReply<T>>): void => {
    ipcMain.handle(`mcp:${channel}`, async (event): Promise<McpHostReply<T>> => {
      if (!fromStudioFrame(event, options.entryUrl)) return { ok: false, refusal: 'no-folder' };
      return run();
    });
  };

  /** Set while a stop was asked for, so the exit it causes is reported as a stop and not as a server that died. */
  let stopping = false;
  /** The start in flight, so two starts cannot each fork a child and kill the other's. */
  let starting: Promise<McpHostReply<McpHostStatus>> | null = null;

  const stopChild = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (running === undefined) return;
    stopping = true;
    const ended = new Promise<void>((resolve) => running.once('exit', () => resolve()));
    running.kill();
    await ended;
    stopping = false;
  };

  /** A start: the same bundle, the open folder, a token this app minted, and writes on or off as the writer chose. */
  const begin = async (folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => {
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
      // The write setting is set explicitly, both ways: a `CAOTANG_MCP_ALLOW_WRITES=true` inherited from whatever launched the app would
      // otherwise expose writes while the switch says they are off (cli.ts reads that variable as an argument).
      env: { ...process.env, CAOTANG_MCP_TOKEN: token, CAOTANG_MCP_ALLOW_WRITES: allowWrites === true ? 'true' : 'false' },
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
        said = `${said}${chunk.toString('utf8')}`.slice(-4096);
        // Against everything it has said so far, because a line can arrive in two chunks.
        const endpoint = ENDPOINT.exec(said.split('\n').map((line) => line.trim()).find((line) => ENDPOINT.test(line)) ?? '');
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
      forked.once('exit', (code) => {
        if (child === forked) child = undefined;
        if (!settled && stopping) {
          // A stop the writer asked for, while the server was still starting: they asked for it to be stopped, and it is.
          publish({ state: 'stopped' });
          settle({ ok: true, value: status });
          return;
        }
        // A server that goes after it was ready, without a stop being asked for, failed: reporting it as stopped would leave the block
        // saying the writer stopped something they did not.
        if (status.state === 'running') {
          publish({ state: 'failed', refusal: 'failed', folderId: status.folderId, detail: said.trim().split('\n').slice(-1)[0] });
        } else if (status.state === 'starting') {
          publish({ state: 'stopped' });
        }
        if (!settled) {
          // The command line's own exit codes say why it would not serve: 3 is the folder another writer holds, 2 is a folder that
          // holds no project and cannot be made one, and anything else is this app's to report (cli.ts).
          const refusal: McpHostRefusal = code === 3 ? 'busy' : 'failed';
          publish({ state: 'failed', refusal, folderId, detail: said.trim().split('\n').slice(-1)[0] });
          settle({ ok: false, refusal });
        }
      });
    });
  };

  const start = async (folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => {
    // One start at a time: a second one while the first is still in its handshake would kill that child mid-start and report a death
    // the writer did not ask for.
    if (starting === null) starting = begin(folderId, allowWrites).finally(() => { starting = null; });
    return await starting;
  };

  /** One control call: the app's own token, its own server, and the pause that stands between a check and a rename. */
  const control = async (what: 'pause' | 'resume'): Promise<McpHostReply<McpHostStatus>> => {
    if (status.state !== 'running' || status.url === undefined || status.token === undefined) {
      // Nothing running is not a failure: a save with no server has nothing to pause.
      return { ok: true, value: status };
    }
    const base = status.url.replace(/\/mcp$/u, '');
    const post = async (): Promise<boolean> => {
      try {
        // A server that does not answer must not hold a save: the app's digest check is the guarantee, and this is the window it closes.
        const response = await fetch(`${base}/control/${what}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${status.token}` },
          signal: AbortSignal.timeout(PAUSE_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    };
    // One attempt each way, never a retry: a resume that timed out may have reached the server and lifted its pause, and a second one
    // would lift another save's. A failed pause costs nothing (the digest check is the guarantee). A failed resume leaves every write
    // refused for the life of that server, so the server is stopped instead — a state the writer can see and act on.
    if (await post()) return { ok: true, value: status };
    if (what === 'resume' && status.state === 'running') {
      const folderId = status.folderId;
      const allowWrites = status.allowWrites === true;
      await stopChild();
      publish({ state: 'stopped', ...(folderId === undefined ? {} : { folderId }), allowWrites, detail: RESTARTED_AFTER_RESUME });
      return { ok: true, value: status };
    }
    return { ok: false, refusal: 'failed' };
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
  ipcMain.removeAllListeners('mcp:unsubscribe');
  ipcMain.on('mcp:subscribe', (event) => {
    if (!fromStudioFrame(event, options.entryUrl)) return;
    const { sender } = event;
    // One entry per page, not one per mount: the same window mounting the block twice replaces its own listener.
    listeners.set(sender.id, (next) => {
      if (!sender.isDestroyed()) sender.send('mcp:status', next);
    });
    sender.once('destroyed', () => listeners.delete(sender.id));
  });
  ipcMain.on('mcp:unsubscribe', (event) => {
    if (!fromStudioFrame(event, options.entryUrl)) return;
    listeners.delete(event.sender.id);
  });

  return { writerPid: () => child?.pid };
}
