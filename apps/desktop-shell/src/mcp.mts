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
 * stands, and the answer comes only once the writes already running have finished; `resume` lifts it when the save is done. Each pause
 * is named by a lease both calls carry, so a save that stops waiting for its pause can send the resume that lets it go even when that
 * pause has not been processed yet — the server cancels the lease, and the pause that lands after it never stands.
 *
 * A folder id, never a path, is what the page names: the grant list every folder channel uses resolves it, so the page cannot point
 * this server at a directory the writer never opened.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { ipcMain, utilityProcess, type UtilityProcess } from 'electron';

import { fromStudioFrame } from './ipc-guard.mjs';
import type { McpHostRefusal, McpHostReply, McpHostStatus } from './mcp-contract.cjs';

/** What the block says when a server that came up during a save could not be paused, and was stopped rather than left reachable. */
export const STARTED_UNPAUSED = 'The server started while Caotang was saving and could not be paused, so it was stopped. Start it again.';

/** What the block says when the server had to be restarted because it did not answer the resume that ends a save. */
export const RESTARTED_AFTER_RESUME = 'The server did not answer while Caotang finished saving, so it was stopped. Start it again.';

/** What the block says when a server that would not answer a pause, or the resume that lets go of one, was stopped instead. */
export const STOPPED_UNPAUSED = 'The server stopped answering while Caotang was saving, so it was stopped. Start it again.';

/** How long a start waits for the server to say it is ready before the app calls it failed. */
const READY_TIMEOUT_MS = 20_000;

/** How long a pause or a resume may take before the save stops waiting for it. */
const PAUSE_TIMEOUT_MS = 2_000;

const ENDPOINT = /^caotang-mcp: MCP endpoint (http:\/\/127\.0\.0\.1:\d+\/mcp)$/u;

/** The header a pause and the resume that lets it go name the same pause in (packages/mcp-server/src/server.ts). */
const CONTROL_LEASE_HEADER = 'x-caotang-pause';

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

  /**
   * One operation at a time. A start, a stop, a pause and a resume all touch the same child, and the bugs this file had were mostly
   * two of them in flight together — a stop landing inside a start, a resume retried while another save paused. The queue is the
   * whole answer to that: one at a time, in the order they were asked for.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * How many saves hold a pause. It is the host's count, not only the child's, because a start forks a child whose own count is zero:
   * a save in flight must pause that child before the page is told its address, or a write could start mid-save.
   */
  let pauses = 0;
  /** The lease the pause standing on the server was raised with, so the resume that lets it go names the same pause. */
  let lease: string | undefined;
  /** Set while a stop was asked for, so the exit it causes is reported as a stop and not as a server that died. */
  let stopping = false;

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

  /**
   * What a control call got. `unanswered` is a call this app sent and then stopped waiting for: the server may be holding what it was
   * asked for, so only that case is owed the other half of the pair. `failed` never reached the server, or was refused there, so it
   * changed nothing.
   */
  const postControl = async (running: McpHostStatus, what: 'pause' | 'resume', lease?: string): Promise<'ok' | 'unanswered' | 'failed'> => {
    if (running.url === undefined || running.token === undefined) return 'failed';
    const base = running.url.replace(/\/mcp$/u, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAUSE_TIMEOUT_MS);
    try {
      // A server that does not answer must not hold a save: the app's digest check is the guarantee, and this is the window it closes.
      const response = await fetch(`${base}/control/${what}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${running.token}`, ...(lease === undefined ? {} : { [CONTROL_LEASE_HEADER]: lease }) },
        signal: controller.signal,
      });
      return response.ok ? 'ok' : 'failed';
    } catch {
      // This app gave up on an answer that was owed, not a call that never got there.
      return controller.signal.aborted ? 'unanswered' : 'failed';
    } finally {
      clearTimeout(timer);
    }
  };

  /** A server that will not take a resume is stopped rather than left holding the folder: the next start takes a fresh child. */
  const stopUnpaused = async (detail: string): Promise<void> => {
    const folderId = status.folderId;
    const allowWrites = status.allowWrites === true;
    await stopChild();
    publish({ state: 'stopped', ...(folderId === undefined ? {} : { folderId }), allowWrites, detail });
  };

  /**
   * A start: the same bundle, the open folder, a token this app minted, and writes on or off as the writer chose. The answer is given
   * only once the child is ready and, if a save is in flight, paused: the address the page receives is never one that accepts writes
   * in the middle of a save.
   */
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
    const since = new Date().toISOString();
    let said = '';

    const ready = await new Promise<{ readonly ok: true; readonly url: string } | { readonly ok: false; readonly refusal: McpHostRefusal }>((resolve) => {
      let done = false;
      const finish = (answer: { readonly ok: true; readonly url: string } | { readonly ok: false; readonly refusal: McpHostRefusal }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        void stopChild();
        finish({ ok: false, refusal: 'failed' });
      }, READY_TIMEOUT_MS);
      forked.stderr?.on('data', (chunk: Buffer) => {
        said = `${said}${chunk.toString('utf8')}`.slice(-4096);
        // Against everything it has said so far, because a line can arrive in two chunks.
        const line = said.split('\n').map((text) => text.trim()).find((text) => ENDPOINT.test(text));
        const endpoint = line === undefined ? null : ENDPOINT.exec(line);
        const url = endpoint?.[1];
        if (url === undefined) return;
        finish({ ok: true, url });
      });
      forked.stderr?.on('end', () => finish({ ok: false, refusal: 'failed' }));
      forked.once('exit', (code) => {
        if (child === forked) child = undefined;
        // The command line's own exit codes say why it would not serve: 3 is the folder another writer holds, 2 is a folder that
        // holds no project and cannot be made one, and anything else is this app's to report (cli.ts).
        finish({ ok: false, refusal: code === 3 ? 'busy' : 'failed' });
      });
    });

    if (!ready.ok) {
      const last = said.trim().split('\n').slice(-1)[0];
      publish({ state: 'failed', refusal: ready.refusal, folderId, ...(last === undefined ? {} : { detail: last }) });
      return { ok: false, refusal: ready.refusal };
    }
    const running: McpHostStatus = { state: 'running', url: ready.url, token, allowWrites: allowWrites === true, since, folderId };
    // A save that began before this start is still saving, so the child is paused before the page hears about it — and if it cannot be
    // paused, it is stopped rather than published: a server reachable in the middle of a save is the one thing this pause exists to
    // prevent, and there is no state for "running, but writes land during a save".
    if (pauses > 0 && (await postControl(running, 'pause', lease)) !== 'ok') {
      await stopChild();
      publish({ state: 'failed', refusal: 'failed', folderId, detail: STARTED_UNPAUSED });
      return { ok: false, refusal: 'failed', detail: STARTED_UNPAUSED };
    }
    publish(running);
    // A child that goes after it was ready, with no stop asked for, failed: reporting it as stopped would say the writer stopped
    // something they did not.
    forked.once('exit', () => {
      if (child === forked) child = undefined;
      if (stopping) return;
      if (status.state !== 'running') return;
      const last = said.trim().split('\n').slice(-1)[0];
      publish({ state: 'failed', refusal: 'failed', folderId, ...(last === undefined ? {} : { detail: last }) });
    });
    return { ok: true, value: running };
  };

  const start = (folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => serial(async () => await begin(folderId, allowWrites));

  const stop = (): Promise<McpHostReply<McpHostStatus>> => serial(async () => {
    await stopChild();
    // The pause count is not cleared: it belongs to the saves in flight, not to the child. A save still running while the server
    // stops holds its lease, and a start that comes before it ends must pause the new child (begin does, from this same count).
    publish({ state: 'stopped' });
    return { ok: true, value: status };
  });

  /**
   * The pause a save takes. A lease is taken whether or not a child exists: a save that begins while the server is stopped or still
   * starting is a save the server must not write during if it appears before that save ends, so the count rises first and only then
   * decides whether there is anyone to tell. Every new child applies the leases outstanding at the moment it is ready.
   */
  const pause = (): Promise<McpHostReply<McpHostStatus>> => serial(async () => {
    pauses += 1;
    if (pauses > 1 || status.state !== 'running') return { ok: true, value: status };
    lease = randomUUID();
    const taken = await postControl(status, 'pause', lease);
    if (taken === 'ok') return { ok: true, value: status };
    // A pause this app stopped waiting for is one the server may have raised anyway — it answers only once the writes already running
    // have finished, and a slow one outlasts this wait. This save is about to be refused and will not send the resume that ends a
    // pause, so that resume goes now, naming the same lease: the server lets that lease go whether the pause has been processed yet or
    // is still to come. A call that never reached the server was never taken, and a resume then would lift a different save's pause, so
    // it sends nothing. The digest check is the guarantee either way.
    const raised = lease;
    lease = undefined;
    if (taken === 'unanswered' && (await postControl(status, 'resume', raised)) !== 'ok') await stopUnpaused(STOPPED_UNPAUSED);
    pauses = Math.max(0, pauses - 1);
    return { ok: false, refusal: 'failed' };
  });

  /** The resume that ends a save. Only the last one is sent, and a server that cannot take it is stopped rather than left refusing. */
  const resume = (): Promise<McpHostReply<McpHostStatus>> => serial(async () => {
    pauses = Math.max(0, pauses - 1);
    if (pauses > 0 || status.state !== 'running') return { ok: true, value: status };
    const raised = lease;
    lease = undefined;
    if ((await postControl(status, 'resume', raised)) === 'ok') return { ok: true, value: status };
    await stopUnpaused(RESTARTED_AFTER_RESUME);
    return { ok: true, value: status };
  });

  ipcMain.handle('mcp:start', async (event, folderId: unknown, allowWrites: unknown): Promise<McpHostReply<McpHostStatus>> => (
    fromStudioFrame(event, options.entryUrl) ? await start(folderId, allowWrites) : { ok: false, refusal: 'no-folder' }
  ));
  handle('stop', () => stop());
  handle('status', async () => ({ ok: true, value: status }));
  handle('pause', () => pause());
  handle('resume', () => resume());

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
