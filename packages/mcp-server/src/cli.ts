/**
 * `caotang-mcp serve --project <dir> [--create <name>] [--allow-writes] [--port <n>]
 * [--token-env CAOTANG_MCP_TOKEN]` — and `--stdio` in place of the port and token.
 *
 * The parser is a pure function, so the flags can be tested without a process. The
 * run sequence is the same one a test drives: open the project (taking its lock),
 * mint or read the token, listen, and wait for a signal or for stdin to end. Every
 * line the server writes goes to stderr, because stdout is the stdio transport's
 * channel and must carry nothing else.
 */

import { parseArgs } from 'node:util';

import { LOCK_FILE, NoProjectError, ProjectLockedError } from '@caotang/sdk/folder';

import { DEFAULT_TOKEN_ENV, resolveToken } from './auth.js';
import { openProject, ProjectContentError, type ProjectSession } from './session.js';
import { createToolRuntime, startHttpServer, startStdioServer, type RunningHttpServer } from './server.js';
import { VERSION } from './version.js';

/** The port a host is pointed at when none is given. Chosen to be unlikely to collide, and stable across restarts. */
export const DEFAULT_PORT = 7433;

/** Raised for a command line the server cannot run. The message is the usage error, for the operator. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ServeOptions {
  readonly project: string;
  readonly create?: string;
  readonly allowWrites: boolean;
  readonly port: number;
  readonly tokenEnv: string;
  readonly stdio: boolean;
}

/** The environment variable that turns writes on, as `--allow-writes` does. Only the value "true" counts. */
export const ALLOW_WRITES_ENV = 'CAOTANG_MCP_ALLOW_WRITES';

/**
 * What the environment says about writes, as one of four words. The raw value is never logged: a host that fails to
 * substitute a setting leaves a template string here, and a log line must not carry whatever a host put in a variable.
 */
function classifyWritesSetting(value: string | undefined): 'unset' | 'true' | 'false' | 'other' {
  if (value === undefined) return 'unset';
  return value === 'true' || value === 'false' ? value : 'other';
}

export const USAGE = `usage: caotang-mcp serve --project <dir> [--create <name>] [--allow-writes] [--port <n>] [--token-env <VAR>]
       caotang-mcp serve --project <dir> [--create <name>] [--allow-writes] --stdio

  --project <dir>      the project folder to serve
  --create <name>      make a new project named <name> when the folder holds no caotang.json (refused, unchanged,
                       if it holds documents, codex files or manifest copies: open that folder in Caotang first)
  --allow-writes       let external callers change the project (off by default: read-only)
  --port <n>           the loopback port for Streamable HTTP (default ${DEFAULT_PORT}; 0 picks one)
  --token-env <VAR>    read the bearer token from this variable (default ${DEFAULT_TOKEN_ENV})
  --stdio              serve over stdin and stdout instead of HTTP (no port, no token)

  ${ALLOW_WRITES_ENV}=true in the environment does the same as --allow-writes (the MCPB bundle sets it).
`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The serve flags, checked. Throws {@link UsageError} for anything the server cannot honour. */
export function parseServeArgs(argv: readonly string[]): ServeOptions | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: 'string' },
        create: { type: 'string' },
        'allow-writes': { type: 'boolean', default: false },
        port: { type: 'string' },
        'token-env': { type: 'string' },
        stdio: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) return 'help';
  if (positionals.length !== 1 || positionals[0] !== 'serve') {
    throw new UsageError(`the only command is "serve", got ${positionals.join(' ')}`);
  }

  if (values.project === undefined || values.project.trim() === '') throw new UsageError('--project <dir> is required');
  if (values.create !== undefined && values.create.trim() === '') throw new UsageError('--create needs a project name');

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port)) throw new UsageError(`--port must be a whole number, got ${JSON.stringify(values.port)}`);
    port = Number(values.port);
    if (port > 65535) throw new UsageError(`--port must be at most 65535, got ${port}`);
  }
  const tokenEnv = values['token-env'] ?? DEFAULT_TOKEN_ENV;
  if (!ENV_NAME.test(tokenEnv)) throw new UsageError(`--token-env must name an environment variable, got ${JSON.stringify(tokenEnv)}`);

  if (values.stdio === true && values.port !== undefined) throw new UsageError('--port does not apply to --stdio');
  if (values.stdio === true && values['token-env'] !== undefined) throw new UsageError('--token-env does not apply to --stdio');

  return {
    project: values.project,
    ...(values.create === undefined ? {} : { create: values.create }),
    allowWrites: values['allow-writes'] === true,
    port,
    tokenEnv,
    stdio: values.stdio === true,
  };
}

/** The lines the server says about itself at start. Written to stderr by the caller. */
export function startupLines(
  session: ProjectSession,
  options: ServeOptions,
  token: { minted: boolean; token: string },
  url?: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  const lines = [`caotang-mcp ${VERSION}: project "${session.state.manifest.project.name}" at ${session.root}`];
  if (session.created) lines.push(`caotang-mcp: made a new project; the folder held no caotang.json`);
  else if (options.create !== undefined) lines.push(`caotang-mcp: the folder already holds a project, so --create "${options.create}" was not used`);
  for (const notice of session.notices) lines.push(`caotang-mcp: notice: ${notice.path}: ${notice.message}`);
  lines.push(
    session.allowWrites
      ? 'caotang-mcp: writes are on: external callers may change this project, and a write that asks the user is confirmed first'
      : 'caotang-mcp: writes are off: this server is read-only (pass --allow-writes to let external callers change the project)',
  );
  if (env !== undefined) {
    const setting = classifyWritesSetting(env[ALLOW_WRITES_ENV]);
    lines.push(
      `caotang-mcp: ${ALLOW_WRITES_ENV} ${
        setting === 'unset' ? 'is unset' : setting === 'other' ? 'is other (not "true", so it does not turn writes on)' : `is "${setting}"`
      }`,
    );
  }
  if (url !== undefined) lines.push(`caotang-mcp: MCP endpoint ${url}`);
  if (!options.stdio) {
    lines.push(
      token.minted
        ? `caotang-mcp: bearer token (shown once, never written to the project): ${token.token}`
        : `caotang-mcp: bearer token taken from ${options.tokenEnv}`,
    );
    lines.push('caotang-mcp: send it as "Authorization: Bearer <token>" on every request');
  }
  return lines;
}

export interface RunIo {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /**
   * Waits until the server should stop, then runs `stop` and resolves. For `http` that is
   * a signal; for `stdio` it is also the end of stdin, which is how a host ends the
   * connection. The bin supplies it; a test supplies one that stops on demand.
   */
  readonly untilDone: (stop: () => Promise<void>, mode: 'http' | 'stdio') => Promise<void>;
}

/**
 * Runs the command line to completion and returns the exit code. `serve` returns when
 * the server stops. Errors are reported on stderr with a code: 2 for a usage or
 * project-location error, 3 for a project another writer holds, 1 for anything else.
 */
export async function runCli(argv: readonly string[], io: RunIo): Promise<number> {
  let options: ServeOptions | 'help';
  try {
    options = parseServeArgs(argv);
  } catch (error) {
    io.stderr(`caotang-mcp: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options === 'help') {
    io.stdout(USAGE);
    return 0;
  }

  // The environment switch is the same switch as the flag. An MCPB bundle has no way to pass a flag conditionally, so its
  // manifest sets this variable from the user's "allow writes" setting. Only the exact value "true" turns writes on.
  const allowWrites = options.allowWrites || io.env[ALLOW_WRITES_ENV] === 'true';

  let session: ProjectSession;
  try {
    session = await openProject({
      root: options.project,
      ...(options.create === undefined ? {} : { create: options.create }),
      allowWrites,
    });
  } catch (error) {
    if (error instanceof NoProjectError || error instanceof ProjectContentError) {
      io.stderr(`caotang-mcp: ${error.message}\n`);
      return 2;
    }
    if (error instanceof ProjectLockedError) {
      io.stderr(`caotang-mcp: ${error.message}. The lock is ${LOCK_FILE} in that folder.\n`);
      return 3;
    }
    io.stderr(`caotang-mcp: could not open the project: ${(error as Error).message}\n`);
    return 1;
  }

  const exitHandler = (): void => session.releaseLockSync();
  process.once('exit', exitHandler);
  try {
    const token = options.stdio ? { token: '', minted: false } : resolveToken(io.env, options.tokenEnv);
    const runtime = createToolRuntime(session);

    if (options.stdio) {
      for (const line of startupLines(session, options, token, undefined, io.env)) io.stderr(`${line}\n`);
      const handle = startStdioServer(runtime);
      await io.untilDone(async () => {
        await handle.close();
      }, 'stdio');
      io.stderr('caotang-mcp: stopped\n');
      return 0;
    }

    const server: RunningHttpServer = await startHttpServer(runtime, { port: options.port, token: token.token });
    for (const line of startupLines(session, options, token, server.url, io.env)) io.stderr(`${line}\n`);
    io.stderr('caotang-mcp: ready\n');
    await io.untilDone(async () => {
      await server.close();
    }, 'http');
    io.stderr('caotang-mcp: stopped\n');
    return 0;
  } catch (error) {
    io.stderr(`caotang-mcp: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await session.close();
    process.off('exit', exitHandler);
  }
}
