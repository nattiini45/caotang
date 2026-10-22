/**
 * `@caotang/cli`: the `caotang` command. The bundle `dist/caotang.mjs` is built from `bin.ts`; the exports here are the pieces a test needs.
 */

export { main, USAGE, type MainIo } from './cli.js';
export { runAgent, type AgentIo } from './run-agent.js';
export { parseAgentArgs, AGENT_USAGE, UsageError, DEFAULT_KEY_ENV, DEFAULT_MAX_MODEL_CALLS, type AgentOptions, type PermissionMode, type OutputFormat } from './agent-args.js';
export { policyFor } from './policy.js';
export { printChanges, unifiedDiff } from './diff-print.js';
export { ExitCode, exitCodeOf, jsonLine, type AgentResultJson, type StreamLine } from './output.js';
