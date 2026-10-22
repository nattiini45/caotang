/**
 * `caotang agent -p <intent> [flags]`: the flags, checked.
 *
 * The parser is a pure function, so every rule can be tested without a process. It throws {@link UsageError} for anything the command
 * cannot honour, and the caller prints the message and the usage on stderr and exits 2. The provider key is never a flag value: it
 * would show in `ps` and in shell history, so it is read from the environment variable `--key-env` names.
 */

import { parseArgs } from 'node:util';

import type { ThinkingLevel } from '@caotang/sdk';

/** Raised for a command line the command cannot run. The message is the usage error, for the operator. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type PermissionMode = 'read-only' | 'auto' | 'approve-all';
export const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'auto', 'approve-all'];
export type OutputFormat = 'text' | 'json' | 'stream-json';
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'stream-json'];
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The variable the key is read from when `--key-env` is not given. */
export const DEFAULT_KEY_ENV = 'CAOTANG_API_KEY';
/** The most model calls a turn may make unless `--max-model-calls` says otherwise: the loop's own bound. */
export const DEFAULT_MAX_MODEL_CALLS = 8;
const MAX_MODEL_CALLS_LIMIT = 1_000;

export type ProviderChoice =
  | { readonly kind: 'mock' }
  | { readonly kind: 'preset'; readonly preset: string; readonly baseUrl?: string; readonly model?: string; readonly thinking?: ThinkingLevel };

export interface AgentOptions {
  /** The intent. `undefined` when it is `-`: the caller reads it from stdin. */
  readonly prompt: string | undefined;
  /** The project folder, as typed. `undefined`: the working directory. */
  readonly project: string | undefined;
  readonly planFile: string | undefined;
  readonly provider: ProviderChoice;
  readonly keyEnv: string;
  readonly permission: PermissionMode;
  /** Present with `approve-all` only: a card is approved when every step still to run is one of these tools. */
  readonly approveTools: readonly string[] | undefined;
  readonly write: boolean;
  readonly outputFormat: OutputFormat;
  readonly maxModelCalls: number;
}

export const AGENT_USAGE = `usage: caotang agent -p <intent> [--project <dir>] (--mock | --provider <preset>) [flags]
       caotang agent -p - ...                      read the intent from stdin

  -p, --prompt <intent>        what to ask the agent (required); "-" reads it from stdin
  --project <dir>              the project folder (default: the working directory)
  --plan-file <plan.json>      run this plan ({ "steps": [{ "tool", "params", "expect" }] }) with no planner call
  --mock                       the demo provider: no key, no network
  --provider <preset>          a provider preset, for example anthropic, openai, openrouter or ollama
  --base-url <url>             the endpoint, when the preset does not fix it
  --model <id>                 the model to send (default: the preset's)
  --thinking <level>           off, low, medium, high, xhigh or max
  --key-env <VAR>              the environment variable that holds the key (default ${DEFAULT_KEY_ENV}); the key is never a flag
  --permission <mode>          read-only (default): every card is cancelled and the project is only read
                               auto: a change that needs no card runs; every card is cancelled
                               approve-all: every card is approved as shown; a cut draft never is
  --approve-tools <t,t,...>    with approve-all: approve a card only if every step is one of these tools
  --write                      save the folder after the turn (default: nothing is written and the diff is printed)
  --output-format <format>     text (default), json or stream-json
  --max-model-calls <n>        the most model calls a turn may make (default ${DEFAULT_MAX_MODEL_CALLS})

Exit codes: 0 done; 1 internal error; 2 usage error; 3 the folder is held by another writer; 4 the turn needs input
(a card was cancelled, a bound was reached, the provider failed); 5 conflict; 6 verification failed; 130 SIGINT; 143 SIGTERM.
`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** The flags that would take a secret as their value. They are refused by name, and the value is never echoed. */
const SECRET_FLAGS: ReadonlySet<string> = new Set(['key', 'api-key', 'apikey', 'api_key', 'secret', 'token', 'password']);

function refuseSecretFlags(argv: readonly string[]): void {
  for (const arg of argv) {
    if (arg === '--') return;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = (eq < 0 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
    if (SECRET_FLAGS.has(name)) {
      throw new UsageError(`--${name} is not accepted: a key on the command line shows in ps and in shell history. Put it in an environment variable and name that variable with --key-env`);
    }
  }
}

/** The agent flags, checked. `argv` is what follows `agent`. */
export function parseAgentArgs(argv: readonly string[]): AgentOptions | 'help' {
  refuseSecretFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        prompt: { type: 'string', short: 'p' },
        project: { type: 'string' },
        'plan-file': { type: 'string' },
        provider: { type: 'string' },
        mock: { type: 'boolean', default: false },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        thinking: { type: 'string' },
        'key-env': { type: 'string' },
        permission: { type: 'string' },
        'approve-tools': { type: 'string' },
        write: { type: 'boolean', default: false },
        'output-format': { type: 'string' },
        'max-model-calls': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return 'help';
  if (positionals.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}; the intent goes after -p`);

  if (values.prompt === undefined) throw new UsageError('-p <intent> is required (use -p - to read the intent from stdin)');
  if (values.prompt !== '-' && values.prompt.trim() === '') throw new UsageError('the intent after -p is empty');
  for (const flag of ['project', 'plan-file'] as const) {
    if (values[flag] !== undefined && values[flag].trim() === '') throw new UsageError(`--${flag} needs a path`);
  }

  const mock = values.mock === true;
  if (mock && values.provider !== undefined) throw new UsageError('--mock and --provider are exclusive');
  if (!mock && values.provider === undefined) throw new UsageError('choose a provider: --mock for the demo provider, or --provider <preset>');
  if (mock) {
    for (const flag of ['base-url', 'model', 'thinking', 'key-env'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} does not apply to --mock`);
    }
  }
  if (values.provider !== undefined && values.provider.trim() === '') throw new UsageError('--provider needs a preset name');
  let thinking: ThinkingLevel | undefined;
  if (values.thinking !== undefined) {
    thinking = THINKING_LEVELS.find((level) => level === values.thinking);
    if (thinking === undefined) throw new UsageError(`--thinking must be one of ${THINKING_LEVELS.join(', ')}, got ${JSON.stringify(values.thinking)}`);
  }
  const keyEnv = values['key-env'] ?? DEFAULT_KEY_ENV;
  if (!ENV_NAME.test(keyEnv)) throw new UsageError(`--key-env must name an environment variable, got ${JSON.stringify(keyEnv)}`);

  const permission = PERMISSION_MODES.find((mode) => mode === (values.permission ?? 'read-only'));
  if (permission === undefined) throw new UsageError(`--permission must be one of ${PERMISSION_MODES.join(', ')}, got ${JSON.stringify(values.permission)}`);
  let approveTools: string[] | undefined;
  if (values['approve-tools'] !== undefined) {
    if (permission !== 'approve-all') throw new UsageError('--approve-tools narrows approve-all, so it needs --permission approve-all');
    approveTools = values['approve-tools'].split(',').map((tool) => tool.trim());
    const bad = approveTools.find((tool) => !TOOL_NAME.test(tool));
    if (bad !== undefined) throw new UsageError(`--approve-tools takes a comma-separated list of tool names, got ${JSON.stringify(bad)}`);
  }
  const write = values.write === true;
  if (write && permission === 'read-only') throw new UsageError('--write needs --permission auto or approve-all: read-only writes nothing');

  const outputFormat = OUTPUT_FORMATS.find((format) => format === (values['output-format'] ?? 'text'));
  if (outputFormat === undefined) throw new UsageError(`--output-format must be one of ${OUTPUT_FORMATS.join(', ')}, got ${JSON.stringify(values['output-format'])}`);

  let maxModelCalls = DEFAULT_MAX_MODEL_CALLS;
  const rawCalls = values['max-model-calls'];
  if (rawCalls !== undefined) {
    if (!isWholeNumber(rawCalls)) throw new UsageError(`--max-model-calls must be a whole number, got ${JSON.stringify(rawCalls)}`);
    maxModelCalls = Number(rawCalls);
    if (maxModelCalls < 1 || maxModelCalls > MAX_MODEL_CALLS_LIMIT) throw new UsageError(`--max-model-calls must be from 1 to ${MAX_MODEL_CALLS_LIMIT}, got ${maxModelCalls}`);
  }

  return {
    prompt: values.prompt === '-' ? undefined : values.prompt,
    project: values.project,
    planFile: values['plan-file'],
    provider: mock
      ? { kind: 'mock' }
      : {
          kind: 'preset',
          preset: values.provider ?? '',
          ...(values['base-url'] === undefined ? {} : { baseUrl: values['base-url'] }),
          ...(values.model === undefined ? {} : { model: values.model }),
          ...(thinking === undefined ? {} : { thinking }),
        },
    keyEnv,
    permission,
    approveTools,
    write,
    outputFormat,
    maxModelCalls,
  };
}

/** Digits only, scanned rather than matched, so a long run of them cannot cost more than one pass. */
function isWholeNumber(text: string): boolean {
  if (text === '') return false;
  for (const char of text) if (char < '0' || char > '9') return false;
  return true;
}
