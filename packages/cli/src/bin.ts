/**
 * The bundle's entry point: `dist/caotang.mjs` is this file, built by Vite with the workspace packages inlined so that plain Node
 * can run it. It connects the process to `main`: its arguments, its environment, its standard streams and its signals.
 */

import { untilDone } from '@caotang/mcp-server';

import { main } from './cli.js';
import { answerFrom } from './run-replay.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One line from stdin, for a command that asks a question: `readStdin` waits for the stream to end, which on a terminal is Ctrl-D
 * and not Enter. This resolves at the first newline — or at Ctrl-D and Ctrl-C, which answer nothing — so `y` and Enter is an answer.
 */
async function readLine(): Promise<string> {
  if (process.stdin.isTTY !== true) return readStdin();
  const { createInterface } = await import('node:readline');
  return answerFrom(createInterface({ input: process.stdin, terminal: true }));
}

// SIGINT and SIGTERM end an agent turn the way the app's Stop does: the waiting card is cancelled, the turn ends, the lock is
// released, and the exit code says which signal it was (130, 143). The MCP server has its own handlers (`untilDone`).
const controller = new AbortController();
let stopped: 'SIGINT' | 'SIGTERM' | undefined;
if (process.argv[2] === 'agent') {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopped ??= signal;
      controller.abort();
    });
  }
}

main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin,
  readLine,
  signal: controller.signal,
  stoppedBy: () => stopped,
  untilDone,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`caotang: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
