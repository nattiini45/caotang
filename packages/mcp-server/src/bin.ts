/**
 * The bundle's entry point: `dist/caotang-mcp.mjs` is this file, built by Vite with the
 * workspace packages inlined so that plain Node can run it. The library exports live
 * in `index.ts`; this file only connects the process to them — its arguments, its
 * environment, its two standard streams, and its signals.
 */

import { runCli } from './cli.js';
import { untilDone } from './process.js';

runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  untilDone,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`caotang-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
