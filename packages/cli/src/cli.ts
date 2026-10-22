/**
 * `caotang`: the one front door. `agent` runs the agent on a project folder, `mcp serve` is the MCP server (`caotang-mcp serve`, the
 * command the `.mcpb` bundle runs, stays as it is). The router takes the first words and hands the rest on.
 */

import { runCli as runMcp, type RunIo } from '@caotang/mcp-server';

import { ExitCode } from './output.js';
import { runAgent, type AgentIo } from './run-agent.js';

export interface MainIo extends AgentIo {
  /** Waits until a served MCP server should stop (see `RunIo.untilDone` of `@caotang/mcp-server`). */
  readonly untilDone: RunIo['untilDone'];
}

export const USAGE = `usage: caotang agent -p <intent> [flags]       run the agent on a project folder (caotang agent --help)
       caotang mcp serve --project <dir> [flags]   serve a project over MCP (caotang mcp --help)
`;

/** Runs the command line to completion and returns the exit code. */
export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return ExitCode.Ok;
  }
  if (command === 'agent') return runAgent(rest, io);
  if (command === 'mcp') return runMcp(rest, io);
  io.stderr(`caotang: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  return ExitCode.Usage;
}

