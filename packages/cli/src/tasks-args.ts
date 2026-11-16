/**
 * `caotang tasks <list|due|run> [flags]`: the flags, checked. A pure function like `parseAgentArgs`, so every rule is tested without
 * a process. `list` and `due` only read; `run` is the only subcommand that takes a provider, a permission or a write.
 */

import { parseArgs } from 'node:util';

import type { ThinkingLevel } from '@caotang/gateway';

import { DEFAULT_KEY_ENV, DEFAULT_MAX_MODEL_CALLS, ENV_NAME, PERMISSION_MODES, UsageError, type PermissionMode } from './agent-args.js';

export type TasksFormat = 'text' | 'json';

export interface ProviderFlags {
  readonly provider: { readonly kind: 'mock' } | { readonly kind: 'preset'; readonly preset: string; readonly baseUrl?: string; readonly model?: string; readonly thinking?: ThinkingLevel };
  readonly keyEnv: string;
}

export interface TasksArgs {
  readonly kind: 'list' | 'due' | 'run';
  readonly project: string | undefined;
  readonly format: TasksFormat;
  /** The state file, as typed. `undefined`: the default outside the project. */
  readonly state: string | undefined;
  readonly timeZone: string | undefined;
  /** run only: the task id or name, exactly as typed. */
  readonly target: string | undefined;
  readonly due: boolean;
  readonly includeOffered: boolean;
  readonly write: boolean;
  readonly permission: PermissionMode;
  /** True when --permission was given: --include-offered needs it explicit. */
  readonly permissionExplicit: boolean;
  readonly approveTools: readonly string[] | undefined;
  readonly maxModelCalls: number;
  readonly providerFlags: ProviderFlags | undefined;
}

export const TASKS_USAGE = `usage: caotang tasks list [--project <dir>] [--format <format>]
       caotang tasks due  [--project <dir>] [--state <file>] [--time-zone <zone>] [--format <format>]
       caotang tasks run <id|name> [--project <dir>] [flags]
       caotang tasks run --due [--project <dir>] [flags]

  list                  print every task in tasks.json: id, name, enabled, schedule, body, permission, cap and any problem
  due                   print the tasks due now on this machine; reads the state file, changes nothing
  run <id|name>         run exactly one task, named explicitly
  run --due             run every due task in file order; an offered task is skipped unless --include-offered

  --project <dir>       the project folder (default: the working directory)
  --state <file>        the machine's last-run state, outside the project (default: ~/.caotang/task-state/<project id>.json)
  --time-zone <zone>    the wall clock the due rule reads (default: this machine's zone), for example Europe/Berlin
  --format <format>     text (default) or json; stdout carries the format only
  --write               run only: save the folder through the single-writer lock (default: the turn stays in memory)
  --permission <mode>   run only: read-only (default), auto or approve-all; the task's own permission is a ceiling on it
  --approve-tools <t,t,...>  run only, with approve-all: approve a card only if every step is one of these tools
  --include-offered     run --due only: also run offered tasks; needs an explicit --permission
  --max-model-calls <n> run only: the most model calls a turn may make (default ${DEFAULT_MAX_MODEL_CALLS}); the task's cap is a ceiling on it
  --mock | --provider <preset>  run only: the demo provider, or a preset (anthropic, openai, openrouter, ollama, ...); a scan needs neither
  --base-url <url>      run only: the endpoint, when the preset does not fix it
  --model <id>          run only: the model to send (default: the preset's)
  --thinking <level>    run only: the thinking level, when the preset takes one
  --key-env <VAR>       run only: the environment variable that holds the key (default ${DEFAULT_KEY_ENV}); the key is never a flag
  -h, --help            print this usage and exit 0

list and due take no lock and write nothing: the folder is byte-identical afterwards. A state path inside the project folder is refused.
Exit codes: 0 ok; 1 internal error; 2 usage error or no project; 3 the folder is held by another writer (--write); 4 a cancelled card,
the model-call bound or a provider failure; 5 conflict; 6 verify failed; 130 and 143 SIGINT and SIGTERM. run --due keeps going after a
failed task and exits with the first non-zero code it met.
`;

const THINKING: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const FORMATS: readonly TasksFormat[] = ['text', 'json'];
const RUN_ONLY = ['write', 'permission', 'approve-tools', 'include-offered', 'max-model-calls', 'mock', 'provider', 'base-url', 'model', 'thinking', 'key-env'] as const;

export function parseTasksArgs(argv: readonly string[]): TasksArgs | 'help' {
  const [sub, ...rest] = argv;
  if (sub === undefined) throw new UsageError('choose a subcommand: list, due or run');
  if (sub === '--help' || sub === '-h') return 'help';
  if (sub !== 'list' && sub !== 'due' && sub !== 'run') throw new UsageError(`unknown subcommand ${JSON.stringify(sub)}: choose list, due or run`);

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: 'string' },
        state: { type: 'string' },
        'time-zone': { type: 'string' },
        format: { type: 'string' },
        write: { type: 'boolean' },
        permission: { type: 'string' },
        'approve-tools': { type: 'string' },
        'include-offered': { type: 'boolean' },
        due: { type: 'boolean' },
        'max-model-calls': { type: 'string' },
        mock: { type: 'boolean' },
        provider: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        thinking: { type: 'string' },
        'key-env': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help === true) return 'help';
  for (const name of RUN_ONLY) {
    if (values[name] !== undefined && values[name] !== false && sub !== 'run') throw new UsageError(`--${name} belongs to run; ${sub} only reads`);
  }
  if (sub === 'list' && values.state !== undefined) throw new UsageError('--state belongs to due and run; list reads definitions only');
  if (positionals.length > 1) throw new UsageError('run takes one task id or name');
  if (sub !== 'run' && positionals.length > 0) throw new UsageError(`${sub} takes no task name`);
  const target = positionals[0];
  const due = values.due === true;
  if (sub === 'run') {
    if (due && target !== undefined) throw new UsageError('run takes a task id or name, or --due, not both');
    if (!due && target === undefined) throw new UsageError('run needs a task id or name, or --due');
  }
  if (values['include-offered'] === true) {
    if (sub !== 'run' || !due) throw new UsageError('--include-offered belongs to run --due');
    if (values.permission === undefined) throw new UsageError('--include-offered runs offered tasks unattended, so it needs an explicit --permission');
  }

  const format = FORMATS.find((candidate) => candidate === (values.format ?? 'text'));
  if (format === undefined) throw new UsageError(`--format must be one of ${FORMATS.join(', ')}, got ${JSON.stringify(values.format)}`);
  const timeZone = values['time-zone'];
  if (timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new UsageError(`--time-zone must name a time zone, got ${JSON.stringify(timeZone)}`);
    }
  }
  const permission = PERMISSION_MODES.find((mode) => mode === (values.permission ?? 'read-only'));
  if (permission === undefined) throw new UsageError(`--permission must be one of ${PERMISSION_MODES.join(', ')}, got ${JSON.stringify(values.permission)}`);
  let approveTools: readonly string[] | undefined;
  if (values['approve-tools'] !== undefined) {
    if (permission !== 'approve-all') throw new UsageError('--approve-tools narrows approve-all, so it needs --permission approve-all');
    approveTools = values['approve-tools'].split(',').map((tool) => tool.trim());
    if (approveTools.some((tool) => tool === '')) throw new UsageError('--approve-tools takes a comma-separated list of tool names');
  }
  let maxModelCalls = DEFAULT_MAX_MODEL_CALLS;
  if (values['max-model-calls'] !== undefined) {
    const n = Number(values['max-model-calls']);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new UsageError(`--max-model-calls must be a whole number from 1 to 100, got ${JSON.stringify(values['max-model-calls'])}`);
    maxModelCalls = n;
  }

  let providerFlags: ProviderFlags | undefined;
  if (sub === 'run') {
    const mock = values.mock === true;
    if (mock && values.provider !== undefined) throw new UsageError('choose one provider: --mock or --provider, not both');
    const keyEnv = values['key-env'] ?? DEFAULT_KEY_ENV;
    if (!ENV_NAME.test(keyEnv)) throw new UsageError(`--key-env must name an environment variable, got ${JSON.stringify(keyEnv)}`);
    const thinking = values.thinking;
    if (thinking !== undefined && !THINKING.includes(thinking as ThinkingLevel)) throw new UsageError(`--thinking must be one of ${THINKING.join(', ')}, got ${JSON.stringify(thinking)}`);
    if (mock || values.provider !== undefined) {
      providerFlags = {
        provider: mock
          ? { kind: 'mock' }
          : {
              kind: 'preset',
              preset: values.provider!,
              ...(values['base-url'] === undefined ? {} : { baseUrl: values['base-url'] }),
              ...(values.model === undefined ? {} : { model: values.model }),
              ...(thinking === undefined ? {} : { thinking: thinking as ThinkingLevel }),
            },
        keyEnv,
      };
      if (!mock && values.provider === '') throw new UsageError('--provider needs a preset name');
    }
  }

  return {
    kind: sub,
    project: values.project,
    format,
    state: values.state,
    timeZone,
    target,
    due: sub === 'run' && due,
    includeOffered: values['include-offered'] === true,
    write: values.write === true,
    permission,
    permissionExplicit: values.permission !== undefined,
    approveTools,
    maxModelCalls,
    providerFlags,
  };
}
