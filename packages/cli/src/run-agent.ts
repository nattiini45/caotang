/**
 * `caotang agent`: one turn of the agent against a project folder, with a policy answering the cards, and the result in the format
 * the caller asked for (agent-harness §11).
 *
 * Stdout carries the chosen format and nothing else, so every write to it goes through `io.stdout` in this file and nowhere calls
 * `console`. Progress, the notes about what was or was not written, and every diagnostic go to stderr. The provider key is read once
 * from the environment variable `--key-env` names and handed to the SDK, which seals it in memory; as a last guard, a key that did
 * reach a line this command writes is replaced before the line leaves.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ProfileError } from '@caotang/gateway';
import {
  FolderChangedError,
  NoProjectError,
  ProjectLockedError,
  LOCK_FILE,
  openProject,
  type AgentEvent,
  type CaotangProject,
  type DecisionRecord,
  type FileChange,
  type ProviderConfig,
  type TurnReport,
} from '@caotang/sdk';

import { AGENT_USAGE, parseAgentArgs, UsageError, type AgentOptions } from './agent-args.js';
import { printChanges } from './diff-print.js';
import { ExitCode, exitCodeOf, jsonLine, type AgentResultJson } from './output.js';
import { policyFor } from './policy.js';

export interface AgentIo {
  readonly env: NodeJS.ProcessEnv;
  /** Relative paths (`--project`, `--plan-file`) are resolved against it. */
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Everything stdin holds, for `-p -`. */
  readonly readStdin: () => Promise<string>;
  /** The fetch the provider calls go through. Default the global. */
  readonly fetch?: typeof fetch;
  /** Aborted by SIGINT or SIGTERM: the waiting card is cancelled, the turn ends, the lock is released. */
  readonly signal?: AbortSignal;
  /** Which signal aborted it. */
  readonly stoppedBy?: () => 'SIGINT' | 'SIGTERM' | undefined;
}

/** A line for the operator. */
const note = (text: string): string => `caotang agent: ${text}\n`;

/** A line writer that replaces the key, wherever it turns up in a line, before the line leaves. */
function guarded(write: (text: string) => void, key: string | undefined): (text: string) => void {
  // A short value is no key, and replacing it would damage ordinary text.
  if (key === undefined || key.length < 8) return write;
  const spellings = [key, JSON.stringify(key).slice(1, -1)];
  return (text) => write(spellings.reduce((line, spelling) => (line.includes(spelling) ? line.split(spelling).join('[redacted]') : line), text));
}

function providerConfig(options: AgentOptions, key: string | undefined): ProviderConfig | 'mock' {
  const { provider } = options;
  if (provider.kind === 'mock') return 'mock';
  return {
    profile: {
      name: provider.preset,
      preset: provider.preset,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      // A preset with no default model (generic) needs the one `--model` names; the requests carry it too.
      ...(provider.model === undefined ? {} : { defaultModel: provider.model }),
    },
    ...(key === undefined ? {} : { apiKey: key }),
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ...(provider.thinking === undefined ? {} : { thinking: provider.thinking }),
  };
}

/** The exit code and the line for an error that stopped the command before a report existed. */
function refusal(error: unknown, keyEnv: string, hadKey: boolean): { readonly code: ExitCode; readonly message: string } {
  if (error instanceof NoProjectError) return { code: ExitCode.Usage, message: error.message };
  if (error instanceof ProjectLockedError) return { code: ExitCode.Locked, message: `${error.message}. The lock is ${LOCK_FILE} in that folder.` };
  if (error instanceof FolderChangedError) return { code: ExitCode.Conflict, message: error.message };
  if (error instanceof ProfileError) {
    const message = error.field === 'apiKey' && !hadKey ? `no key: set ${keyEnv} to the provider key, or name another variable with --key-env` : error.message;
    return { code: ExitCode.Usage, message };
  }
  return { code: ExitCode.Internal, message: error instanceof Error ? error.message : String(error) };
}

/** What a person watching the terminal sees of an event: streamed text as it comes, the cards as lines. */
function progressOf(event: AgentEvent): { readonly text: string; readonly inline: boolean } | undefined {
  switch (event.type) {
    case 'model.delta':
    case 'draft.delta':
      return { text: event.delta, inline: true };
    case 'plan':
      return { text: `plan: ${event.card.steps.map((step) => step.tool).join(', ')}`, inline: false };
    case 'card':
      return { text: `${event.card.tool}: ${event.card.status}${event.card.summary === undefined ? '' : ` (${event.card.summary})`}`, inline: false };
    default:
      return undefined;
  }
}

async function readPlan(path: string, cwd: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(resolve(cwd, path), 'utf8');
  } catch (error) {
    throw new UsageError(`--plan-file ${JSON.stringify(path)} cannot be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--plan-file ${JSON.stringify(path)} is not JSON: ${(error as Error).message}`);
  }
}

/** Runs the command line to completion and returns the exit code (see {@link ExitCode}). */
export async function runAgent(argv: readonly string[], io: AgentIo): Promise<ExitCode> {
  let options: AgentOptions | 'help';
  let prompt: string;
  let plan: unknown;
  try {
    options = parseAgentArgs(argv);
    if (options === 'help') {
      io.stdout(AGENT_USAGE);
      return ExitCode.Ok;
    }
    prompt = options.prompt ?? (await io.readStdin()).trim();
    if (prompt === '') throw new UsageError('the intent is empty: nothing came in on stdin');
    plan = options.planFile === undefined ? undefined : await readPlan(options.planFile, io.cwd);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${note(error.message)}\n${AGENT_USAGE}`);
    return ExitCode.Usage;
  }

  const rawKey = io.env[options.keyEnv]?.trim();
  const key = rawKey === undefined || rawKey === '' ? undefined : rawKey;
  const out = guarded(io.stdout, key);
  const err = guarded(io.stderr, key);
  const text = options.outputFormat === 'text';
  const stream = options.outputFormat === 'stream-json';

  const saved: FileChange[] = [];
  const onDecision = (record: DecisionRecord): void => {
    if (record.action !== 'approve' && record.action !== 'cancel') return;
    if (stream) out(jsonLine({ type: 'decision', turnId: record.turnId, kind: record.kind, action: record.action, reason: record.reason }));
    else if (text) err(`\ndecision: ${record.action}: ${record.reason}\n`);
  };

  let project: CaotangProject;
  try {
    project = await openProject({
      root: resolve(io.cwd, options.project ?? '.'),
      provider: providerConfig(options, key),
      approval: policyFor(options.permission, options.approveTools),
      write: options.write,
      maxModelCalls: options.maxModelCalls,
      onDecision,
      onSave: (changes) => saved.push(...changes),
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    });
  } catch (error) {
    const { code, message } = refusal(error, options.keyEnv, key !== undefined);
    err(note(message));
    return code;
  }

  let exitCode: ExitCode = ExitCode.Internal;
  try {
    if (stream) out(jsonLine({ type: 'start', version: 1, project: project.root, permission: options.permission }));
    const run = project.run(prompt, { ...(io.signal === undefined ? {} : { signal: io.signal }), ...(plan === undefined ? {} : { plan }) });
    let inline = false;
    for await (const event of run) {
      if (stream) out(jsonLine({ type: 'event', event }));
      else if (text) {
        const progress = progressOf(event);
        if (progress === undefined) continue;
        err(`${inline && !progress.inline ? '\n' : ''}${progress.text}${progress.inline ? '' : '\n'}`);
        inline = progress.inline;
      }
    }
    if (inline) err('\n');
    const report = await run.report;

    const changes = options.write ? saved : await project.diff();
    const stopped = io.stoppedBy?.();
    exitCode = stopped === 'SIGINT' ? ExitCode.Interrupted : stopped === 'SIGTERM' ? ExitCode.Terminated : exitCodeOf(report);
    finish(options, project, report, changes, exitCode, out, err);
  } catch (error) {
    const refused = refusal(error, options.keyEnv, key !== undefined);
    err(note(refused.message));
    exitCode = refused.code;
  } finally {
    try {
      await project.close();
    } catch (error) {
      err(note(`the project could not be closed cleanly: ${(error as Error).message}`));
      if (exitCode === ExitCode.Ok) exitCode = ExitCode.Internal;
    }
  }
  return exitCode;
}

/** Writes the result in the chosen format, and the notes a person needs beside it on stderr. */
function finish(
  options: AgentOptions,
  project: CaotangProject,
  report: TurnReport,
  changes: readonly FileChange[],
  exitCode: ExitCode,
  out: (text: string) => void,
  err: (text: string) => void,
): void {
  const written = options.write && changes.length > 0;
  if (options.outputFormat === 'text') {
    out(`${report.text ?? report.summary}\n`);
    if (changes.length > 0) out(`\n${printChanges(changes)}`);
    if (report.askBack !== undefined) err(note(`${report.askBack.code}: ${report.askBack.reason}`));
    if (changes.length > 0) err(note(written ? `wrote ${changes.length} file${changes.length === 1 ? '' : 's'}` : `nothing was written: ${changes.length} file${changes.length === 1 ? '' : 's'} would change; pass --write to save them`));
    return;
  }
  const result: AgentResultJson = {
    type: 'result',
    version: 1,
    project: project.root,
    provider: project.provider.preset === 'mock' ? { preset: 'mock' } : project.provider,
    permission: options.permission,
    written,
    report,
    changes,
    exitCode,
  };
  out(jsonLine(result));
}
