/**
 * `caotang replay`: a recorded turn, or one of its model calls, run against a model the caller names, on a copy of the project
 * (agent-harness.md §8.1).
 *
 * Nothing is written and no folder changes on disk: the project is opened read-only, a turn or a cassette runs on its own copy,
 * and the comparison is printed. A replay spends the caller's money, so the estimate is printed and the run waits for `y` unless
 * `--yes` says the caller already agreed. Stdout carries the chosen format and nothing else; the estimate and every note go to
 * stderr.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FolderChangedError, NoProjectError, ProjectLockedError, openProject, type CaotangProject, type ReplayResult } from '@caotang/sdk';
import { ProfileError } from '@caotang/gateway';

import { UsageError } from './agent-args.js';
import { ExitCode, exitCodeOf } from './output.js';
import { policyFor } from './policy.js';
import { providerConfig, type AgentIo } from './run-agent.js';
import { REPLAY_USAGE, parseReplayArgs } from './replay-args.js';

export interface ReplayIo extends AgentIo {
  /**
   * One line from the terminal: the answer to the confirmation, so Enter ends it. Absent, `readStdin` is used, which waits for the
   * stream to end — right for a pipe, wrong for a person.
   */
  readonly readLine?: () => Promise<string>;
}

const note = (text: string): string => `caotang replay: ${text}\n`;

/** The reader a confirmation needs: one line, and the two ways a person cancels it. */
export interface AnswerSource {
  once(event: 'line' | 'close' | 'SIGINT', handler: (text?: string) => void): unknown;
  close(): void;
}

/**
 * One answer from a line reader. Enter gives a line; Ctrl-D closes the reader and Ctrl-C raises SIGINT, and both are the writer
 * saying no, so both answer with nothing rather than leaving the command waiting for a key that will never come.
 */
export function answerFrom(source: AnswerSource): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const settle = (text?: string): void => {
      if (settled) return;
      settled = true;
      source.close();
      resolve(text ?? '');
    };
    source.once('line', settle);
    source.once('close', () => settle(''));
    source.once('SIGINT', () => settle(''));
  });
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Thousands-separated, so a token count reads at a glance. */
const count = (value: number): string => value.toLocaleString('en-US');

function money(usd: number | undefined): string {
  if (usd === undefined) return 'no price row for this model';
  return usd < 0.01 ? 'under a cent' : `about $${usd.toFixed(2)}`;
}

/** The estimate, in the words a writer can check before spending: how many calls, how many tokens at most, and what it costs. */
function estimateLine(result: { readonly promptTokens: number; readonly maxCompletionTokens: number; readonly modelCalls: number; readonly costUsd?: number }): string {
  return note(
    `${result.modelCalls} model ${result.modelCalls === 1 ? 'call' : 'calls'}: ${count(result.promptTokens)} prompt tokens, at most ${count(result.maxCompletionTokens)} back; ${money(result.costUsd)}.`,
  );
}

/** The comparison, for a terminal: the steps that moved, both sides' tokens, and where the replay stopped. */
function report(result: ReplayResult): string {
  const lines: string[] = [];
  const changed = result.steps.filter((step) => step.changedParams.length > 0 || step.replay === undefined || step.original === undefined);
  lines.push(note(`${result.steps.length} ${result.steps.length === 1 ? 'step' : 'steps'} in the recording, ${changed.length} ${changed.length === 1 ? 'differs' : 'differ'}.`));
  for (const step of changed) {
    const was = step.original === undefined ? 'nothing' : `${step.original.tool}`;
    const now = step.replay === undefined ? 'nothing' : `${step.replay.tool}`;
    const which = step.changedParams.length === 0 ? '' : ` (${step.changedParams.join(', ')} changed)`;
    lines.push(note(`  ${step.index + 1}: ${was} → ${now}${which}`));
  }
  lines.push(
    note(
      `tokens: recording ${count(result.usage.original.promptTokens)} prompt + ${count(result.usage.original.completionTokens)} back over ${result.usage.original.modelCalls}; replay ${count(result.usage.replay.promptTokens)} + ${count(result.usage.replay.completionTokens)} over ${result.usage.replay.modelCalls} (${money(result.usage.replay.costUsd)}).`,
    ),
  );
  if (result.reply !== undefined) lines.push(`reply:\n${result.reply.content}\n`);
  if (result.report !== undefined) lines.push(`${result.report.status}: ${result.report.summary}\n`);
  if (result.stoppedAt !== undefined) lines.push(note(`stopped: ${result.stoppedAt.reason} — ${result.stoppedAt.detail}`));
  lines.push(note('the project was not changed.'));
  return lines.join('');
}

/** The machine-readable form, for a script: the mode, the steps, both sides' usage and where it stopped. */
function jsonOf(result: ReplayResult, project: string): string {
  return `${JSON.stringify({
    type: 'replay',
    version: 1,
    project,
    mode: result.mode,
    steps: result.steps,
    usage: result.usage,
    ...(result.reply === undefined ? {} : { reply: result.reply }),
    ...(result.report === undefined ? {} : { status: result.report.status, summary: result.report.summary, tokens: result.report.tokens, ...(result.report.costUsd === undefined ? {} : { costUsd: result.report.costUsd }) }),
    ...(result.stoppedAt === undefined ? {} : { stopped: result.stoppedAt }),
  }, null, 2)}\n`;
}

export async function runReplayCommand(argv: readonly string[], io: ReplayIo): Promise<number> {
  let parsed;
  try {
    parsed = parseReplayArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`caotang replay: ${error.message}\n\n${REPLAY_USAGE}`);
    return ExitCode.Usage;
  }
  if (parsed === 'help') {
    io.stdout(REPLAY_USAGE);
    return ExitCode.Ok;
  }

  const root = resolve(io.cwd, parsed.agent.project ?? '.');
  const keyEnv = parsed.agent.keyEnv;
  const readTrace = (): Promise<string> =>
    readFile(resolve(io.cwd, parsed.trace), 'utf8').catch((error: unknown) => {
      throw new UsageError(`cannot read ${parsed.trace}: ${messageOf(error)}`);
    });
  const key = io.env[keyEnv];

  let project: CaotangProject | undefined;
  try {
    const trace = await readTrace();
    project = await openProject({
      root,
      provider: providerConfig(parsed.agent, key),
      approval: policyFor(parsed.agent.permission, parsed.agent.approveTools),
      // Read-only, always: a replay compares, and only the dialog's "Use this version" ever reaches the project (§8.1).
      write: false,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    });
    const input = {
      trace,
      mode: parsed.mode,
      ...(parsed.turnId === undefined ? {} : { turnId: parsed.turnId }),
      ...(parsed.callIndex === undefined ? {} : { callIndex: parsed.callIndex }),
      ...(parsed.agent.maxModelCalls === undefined ? {} : { maxModelCalls: parsed.agent.maxModelCalls }),
    };
    const estimate = project.replayEstimate(input);
    io.stderr(estimateLine(estimate));

    if (!parsed.confirmed) {
      io.stderr(note('run it? y to spend that, anything else to stop: '));
      const answer = (await (io.readLine ?? io.readStdin)()).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.stderr(note('nothing was sent; the recording is unchanged.'));
        return ExitCode.Ok;
      }
    }

    const result = await project.replay(input);
    io.stdout(parsed.agent.outputFormat === 'json' ? jsonOf(result, root) : report(result));
    // A replay that stopped on a card or an external step needs a person; one whose turn failed or was cancelled says so in its own
    // status, exactly as `caotang agent` maps that report.
    if (result.stoppedAt !== undefined) return ExitCode.NeedsInput;
    return result.report === undefined ? ExitCode.Ok : exitCodeOf(result.report);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`caotang replay: ${error.message}\n\n${REPLAY_USAGE}`);
      return ExitCode.Usage;
    }
    if (error instanceof NoProjectError) {
      io.stderr(note(error.message));
      return ExitCode.Usage;
    }
    if (error instanceof ProjectLockedError) {
      io.stderr(note(`${error.message}. Another program is writing this project.`));
      return ExitCode.Locked;
    }
    if (error instanceof FolderChangedError) {
      io.stderr(note(error.message));
      return ExitCode.Conflict;
    }
    if (error instanceof ProfileError) {
      const missing = key === undefined || key === '';
      io.stderr(note(`${error.message}${missing ? ` Set ${keyEnv} to the key for this provider.` : ''}`));
      return ExitCode.Usage;
    }
    io.stderr(note(messageOf(error)));
    return ExitCode.Internal;
  } finally {
    await project?.close();
  }
}
