/**
 * `caotang replay`'s own flags (agent-harness §8.1). Everything about the destination — the project, the provider preset, the model,
 * the key's variable, the permission policy — is the `agent` command's, parsed by its own parser, so a replay cannot be pointed
 * anywhere `caotang agent` could not: the two commands accept the same names with the same meanings. This file adds the four words
 * a replay needs of its own: the trace file, its mode, the turn, the call, and the confirmation.
 */

import type { ReplayMode } from '@caotang/sdk';

import { parseAgentArgs, UsageError, type AgentOptions } from './agent-args.js';

export const REPLAY_USAGE = `usage: caotang replay <trace.jsonl> [--mode call|turn|cassette] [--project <dir>] (--mock | --provider <preset>)
       caotang replay <trace.jsonl> --turn <id> --call <n> [--yes]

Replays a recorded turn — or one of its model calls — against a model you choose, on a copy of the project. Nothing is written:
the project is only read, and the comparison is printed.

  <trace.jsonl>                the trace, as the app exports it (caotang.trace/1)
  --mode <mode>                call (default): replay one recorded model call, no tool runs
                               turn: re-run the whole turn against your provider, re-applying the recorded decisions
                               cassette: re-run the whole turn from the recorded answers, free and with no key
  --turn <id>                  the turn to replay (default: the last one in the trace)
  --call <n>                   which model call, for --mode call (default: the turn's first)
  --yes                        run without asking; otherwise the estimate is printed and the run waits for y
  --project <dir>              the project folder (default: the working directory)
  --mock                       the demo provider: no key, no network
  --provider <preset>          a provider preset, for example anthropic, openai, openrouter or ollama
  --base-url <url>             the endpoint, when the preset does not fix it
  --model <id>                 the model to send (default: the preset's)
  --thinking <level>           off, low, medium, high, xhigh or max
  --key-env <VAR>              the environment variable that holds the key (default CAOTANG_API_KEY); the key is never a flag
  --permission <mode>          approves a card the recording does not have: read-only (default) cancels it
  --output-format <format>     text (default) or json

Exit codes: 0 replayed; 1 internal error; 2 usage error; 3 the folder is held by another writer; 4 the replay stopped on a card or an
external step and needs you; 130 SIGINT; 143 SIGTERM.
`;

export interface ReplayArgs {
  readonly trace: string;
  readonly mode: ReplayMode;
  readonly turnId?: string;
  readonly callIndex?: number;
  readonly confirmed: boolean;
  /** The `agent` flags, parsed by their own parser: the project, the provider and the key's variable. */
  readonly agent: AgentOptions;
}

const MODES: ReadonlySet<string> = new Set(['call', 'turn', 'cassette']);

/** The `agent` flags that take a value, so a replay's own flags never steal one's argument. */
const AGENT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p', '--prompt', '--project', '--plan-file', '--provider', '--base-url', '--model', '--thinking', '--key-env', '--permission', '--approve-tools', '--output-format', '--max-model-calls',
]);

export function parseReplayArgs(argv: readonly string[]): ReplayArgs | 'help' {
  const theirs: string[] = [];
  let trace: string | undefined;
  let mode: ReplayMode = 'call';
  let turnId: string | undefined;
  let callIndex: number | undefined;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') return 'help';
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
      const given = inline ?? argv[index + 1];
      if (given === undefined) throw new UsageError(`${name} needs a value`);
      if (inline === undefined) index += 1;
      return given;
    };
    if (name === '--mode') {
      const asked = value();
      if (!MODES.has(asked)) throw new UsageError(`--mode must be call, turn or cassette, not ${JSON.stringify(asked)}`);
      mode = asked as ReplayMode;
    } else if (name === '--turn') {
      turnId = value();
    } else if (name === '--call') {
      const asked = value();
      const number = Number(asked);
      if (!Number.isInteger(number) || number < 1) throw new UsageError(`--call takes a request number, not ${JSON.stringify(asked)}`);
      callIndex = number;
    } else if (name === '--yes') {
      confirmed = true;
    } else if (AGENT_VALUE_FLAGS.has(name)) {
      theirs.push(name);
      if (inline !== undefined) theirs.push(inline);
      else {
        const given = argv[index + 1];
        if (given !== undefined) {
          theirs.push(given);
          index += 1;
        }
      }
    } else if (arg.startsWith('-')) {
      theirs.push(arg);
    } else if (trace === undefined) {
      trace = arg;
    } else {
      throw new UsageError(`caotang replay takes one trace file, not ${JSON.stringify(arg)}`);
    }
  }
  if (trace === undefined) throw new UsageError('name the trace file to replay: caotang replay <trace.jsonl>');
  // `--plan-file` is the agent command's way to run a plan nobody planned; a replay's steps come from the recording, so the flag
  // would be silently ignored and say something untrue about the run.
  if (theirs.includes('--plan-file')) throw new UsageError('--plan-file is not accepted: a replay runs the steps the recording holds, never a plan you name');
  // The agent parser owns the destination's flags, including the refusals a key on the command line gets.
  const agent = parseAgentArgs(['-p', 'replay', ...theirs]);
  if (agent === 'help') return 'help';
  return { trace, mode, ...(turnId === undefined ? {} : { turnId }), ...(callIndex === undefined ? {} : { callIndex }), confirmed, agent };
}
