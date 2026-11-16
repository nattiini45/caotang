/**
 * `caotang tasks`: the recurring tasks of a project folder, for a scheduler or CI with no tab open (agent-harness.md §12).
 *
 * `list` and `due` read through a folder port that refuses every write and take no lock: the folder is byte-identical afterwards.
 * `run` opens the project through the SDK, one task at a time, under the lowest of the task's permission ceiling and `--permission`,
 * with the lowest of the task's call cap and `--max-model-calls`. Each settled run records its instant in the machine's state file,
 * outside the project; a refusal before a run starts records nothing. Stdout carries the chosen format only; notes go to stderr.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { NodeArtifactFs, defaultTaskStatePath, loadTaskState, manifestOnDisk, saveTaskState } from '@caotang/sdk/folder';
import { openProject, type CaotangProject, type FileChange, type ProviderConfig } from '@caotang/sdk';
import { dueTasks, effectiveWhenDue, loadTasks, usesModel, withHandled, type AgentTask, type TaskStateFile, type TasksFile } from '@caotang/tasks';
import type { ArtifactFs } from '@caotang/store';

import { UsageError } from './agent-args.js';
import { printChanges } from './diff-print.js';
import { ExitCode, exitCodeOf } from './output.js';
import { policyFor } from './policy.js';
import { TASKS_USAGE, parseTasksArgs, type TasksArgs } from './tasks-args.js';

export interface TasksIo {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly stoppedBy?: () => 'SIGINT' | 'SIGTERM' | undefined;
  /** The instant the due rule and the state record read. Default: the host clock. */
  readonly now?: () => Date;
}

const note = (text: string): string => `caotang tasks: ${text}\n`;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The folder's port with every write refused: a reading command cannot change a byte, whatever the code under it does. */
function readOnly(fs: NodeArtifactFs): ArtifactFs {
  const refuse = (): Promise<never> => Promise.reject(new Error('tasks list and due only read the folder'));
  return {
    read: (path) => fs.read(path),
    readBytes: (path) => fs.readBytes(path),
    exists: (path) => fs.exists(path),
    listFiles: (dir) => fs.listFiles(dir),
    listDirs: (dir) => fs.listDirs(dir),
    writeAtomic: refuse,
    writeBytesAtomic: refuse,
    ensureDir: refuse,
    remove: refuse,
  };
}

const scheduleOf = (task: AgentTask): string => {
  const s = task.schedule;
  if (s.kind === 'weekly') return `weekly ${s.day} ${s.at}`;
  if (s.kind === 'daily') return `daily ${s.at}`;
  return s.kind;
};

const rowOf = (task: AgentTask) => ({
  id: task.id,
  name: task.name,
  enabled: task.enabled,
  schedule: scheduleOf(task),
  whenDue: task.whenDue,
  body: task.body.kind,
  permission: task.permission,
  maxModelCalls: task.maxModelCalls ?? null,
  problem: task.problem ?? null,
});

function printRows(tasks: readonly AgentTask[], format: TasksArgs['format'], out: (text: string) => void): void {
  if (format === 'json') {
    out(`${JSON.stringify({ type: 'tasks', version: 1, tasks: tasks.map(rowOf) }, null, 2)}\n`);
    return;
  }
  if (tasks.length === 0) {
    out('No tasks.\n');
    return;
  }
  for (const task of tasks) {
    const row = rowOf(task);
    out(`${row.id}  ${row.name}  ${row.enabled ? 'on' : 'off'}  ${row.schedule}  ${row.body}  ${row.permission}${row.maxModelCalls === null ? '' : `  cap ${row.maxModelCalls}`}${row.problem === null ? '' : `  problem: ${row.problem}`}\n`);
  }
}

/** The project id the default state file is named after, read without a lock. */
async function projectIdOf(fs: NodeArtifactFs, root: string): Promise<string> {
  const text = await manifestOnDisk(fs);
  if (text === undefined) throw new UsageError(`the folder ${root} holds no caotang.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError(`the caotang.json in ${root} is not JSON`);
  }
  const project = typeof raw === 'object' && raw !== null && 'project' in raw ? (raw as { project: unknown }).project : undefined;
  const id = typeof project === 'object' && project !== null && 'id' in project ? (project as { id: unknown }).id : undefined;
  if (typeof id !== 'string' || id === '') throw new UsageError(`the caotang.json in ${root} has no project id`);
  return id;
}

function statePathOf(args: TasksArgs, io: TasksIo, root: string, projectId: string): string {
  const path = args.state === undefined ? defaultTaskStatePath(projectId) : resolve(io.cwd, args.state);
  if (isInside(root, path)) throw new UsageError(`--state must name a file outside the project folder: ${path} is inside it, and the project stays byte-identical`);
  return path;
}

async function readState(path: string, now: Date, err: (text: string) => void): Promise<TaskStateFile | undefined> {
  const loaded = await loadTaskState(path, now);
  if (loaded.kind === 'refused') {
    err(note(loaded.message));
    return undefined;
  }
  if (loaded.notice !== undefined) err(note(loaded.notice));
  return loaded.file;
}

/** The one task a name or id selects: an id first, then an exact name; two tasks of one name are refused by id. */
function selectTask(file: TasksFile, target: string): AgentTask {
  const byId = file.tasks.find((task) => task.id === target);
  if (byId !== undefined) return byId;
  const named = file.tasks.filter((task) => task.name === target);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new UsageError(`several tasks are named ${JSON.stringify(target)}: name one by id (${named.map((task) => task.id).join(', ')})`);
  throw new UsageError(`no task has the id or name ${JSON.stringify(target)}`);
}

const providerConfig = (flags: NonNullable<TasksArgs['providerFlags']>, key: string | undefined): ProviderConfig | 'mock' => {
  if (flags.provider.kind === 'mock') return 'mock';
  const p = flags.provider;
  return {
    profile: { name: p.preset, preset: p.preset, ...(p.baseUrl === undefined ? {} : { baseUrl: p.baseUrl }) },
    ...(key === undefined ? {} : { apiKey: key }),
    ...(p.model === undefined ? {} : { model: p.model }),
    ...(p.thinking === undefined ? {} : { thinking: p.thinking }),
    role: 'background',
  };
};

/** The permission a task runs under: the file's ceiling over the flag's mode (agent-harness §12). */
export function modeFor(task: AgentTask, flag: 'read-only' | 'auto' | 'approve-all'): 'read-only' | 'auto' | 'approve-all' {
  return task.permission === 'read-only' ? 'read-only' : flag;
}

/** The call cap a task runs under: the lowest of its own cap and the flag's. */
export function capFor(task: AgentTask, flag: number): number {
  return Math.min(task.maxModelCalls ?? flag, flag);
}

interface TaskOutcome {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly summary: string;
  readonly exitCode: ExitCode;
  readonly changes: readonly FileChange[];
}

/** Runs one task on an open project and reports what it did. The state record is the caller's, after this settles. */
async function runOne(project: CaotangProject, task: AgentTask, args: TasksArgs, io: TasksIo, err: (text: string) => void): Promise<TaskOutcome> {
  if (task.body.kind === 'scan') {
    const outcome = await project.call('coherence.scan', { scope: { mode: task.body.scope }, ...(task.body.checks === undefined ? {} : { checks: task.body.checks }) });
    if (!outcome.ok) return { id: task.id, name: task.name, status: 'failed', summary: outcome.error.message, exitCode: ExitCode.NeedsInput, changes: [] };
    const value = outcome.value as { readonly summary?: string; readonly findings?: readonly unknown[] };
    const summary = value.summary ?? 'the scan is recorded';
    return { id: task.id, name: task.name, status: 'done', summary, exitCode: ExitCode.Ok, changes: args.write ? [] : await project.diff() };
  }
  const plan = task.body.kind === 'plan' ? { steps: task.body.steps } : undefined;
  const intent = task.body.kind === 'intent' ? task.body.text : task.name;
  const run = project.run(intent, { ...(io.signal === undefined ? {} : { signal: io.signal }), ...(plan === undefined ? {} : { plan }) });
  for await (const event of run) {
    if (args.format !== 'text') continue;
    if (event.type === 'card') err(`card: ${event.card.tool}: ${event.card.status}\n`);
  }
  const report = await run.report;
  const stopped = io.stoppedBy?.();
  const exitCode = stopped === 'SIGINT' ? ExitCode.Interrupted : stopped === 'SIGTERM' ? ExitCode.Terminated : exitCodeOf(report);
  const changes = args.write ? [] : await project.diff();
  return { id: task.id, name: task.name, status: report.status, summary: report.text ?? report.summary, exitCode, changes };
}

/** Runs the command line to completion and returns the exit code. */
export async function runTasksCommand(argv: readonly string[], io: TasksIo): Promise<number> {
  let args: TasksArgs | 'help';
  try {
    args = parseTasksArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${note(error.message)}\n${TASKS_USAGE}`);
    return ExitCode.Usage;
  }
  if (args === 'help') {
    io.stdout(TASKS_USAGE);
    return ExitCode.Ok;
  }
  const out = io.stdout;
  const err = io.stderr;
  const now = io.now ?? ((): Date => new Date());
  const root = resolve(io.cwd, args.project ?? '.');
  let fs: NodeArtifactFs;
  try {
    fs = new NodeArtifactFs(root);
  } catch (error) {
    err(note(messageOf(error)));
    return ExitCode.Usage;
  }
  let projectId: string;
  try {
    projectId = await projectIdOf(fs, root);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(note(error.message));
    return ExitCode.Usage;
  }
  const load = await loadTasks(readOnly(fs), { now: now() });
  for (const notice of load.notices) err(note(notice.message));
  const file = load.file;

  if (args.kind === 'list') {
    printRows(file.tasks, args.format, out);
    return ExitCode.Ok;
  }
  if (load.status === 'read-only') {
    err(note('tasks.json is from a newer Caotang or is not a Caotang tasks file; rename or remove it to run tasks here'));
    return ExitCode.Internal;
  }
  let statePath: string;
  try {
    statePath = statePathOf(args, io, root, projectId);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(note(error.message));
    return ExitCode.Usage;
  }
  const timeZone = args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let state = await readState(statePath, now(), err);
  if (state === undefined) return ExitCode.Internal;

  if (args.kind === 'due') {
    const due = dueTasks(file, state.lastRuns, now(), timeZone, false);
    printRows(due, args.format, out);
    return ExitCode.Ok;
  }

  let selected: AgentTask[];
  try {
    selected = args.due ? dueTasks(file, state.lastRuns, now(), timeZone, false) : [selectTask(file, args.target!)];
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(note(error.message));
    return ExitCode.Usage;
  }
  if (args.due && !args.includeOffered) selected = selected.filter((task) => effectiveWhenDue(task) === 'run');
  if (selected.some((task) => usesModel(task)) && args.providerFlags === undefined) {
    err(note('a model task needs a provider: --mock for the demo provider, or --provider <preset>'));
    return ExitCode.Usage;
  }
  const rawKey = args.providerFlags === undefined ? undefined : io.env[args.providerFlags.keyEnv]?.trim();
  const key = rawKey === undefined || rawKey === '' ? undefined : rawKey;

  const outcomes: TaskOutcome[] = [];
  let firstBad: ExitCode = ExitCode.Ok;
  for (const task of selected) {
    if (task.problem !== undefined) {
      err(note(`${task.name} cannot run: ${task.problem}`));
      if (firstBad === ExitCode.Ok) firstBad = ExitCode.NeedsInput;
      outcomes.push({ id: task.id, name: task.name, status: 'failed', summary: task.problem, exitCode: ExitCode.NeedsInput, changes: [] });
      continue;
    }
    const mode = modeFor(task, args.permission);
    const cap = capFor(task, args.maxModelCalls);
    let project: CaotangProject;
    try {
      project = await openProject({
        root,
        provider: args.providerFlags === undefined ? 'mock' : providerConfig(args.providerFlags, key),
        // A scan body is the deterministic appender: it changes no text, so it runs as `caotang scan --write` does, under no card policy.
        approval: task.body.kind === 'scan' ? 'auto' : policyFor(mode, args.approveTools),
        write: args.write,
        maxModelCalls: cap,
        ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      });
    } catch (error) {
      err(note(messageOf(error)));
      if (firstBad === ExitCode.Ok) firstBad = ExitCode.Internal;
      outcomes.push({ id: task.id, name: task.name, status: 'failed', summary: messageOf(error), exitCode: ExitCode.Internal, changes: [] });
      continue;
    }
    let outcome: TaskOutcome = { id: task.id, name: task.name, status: 'failed', summary: '', exitCode: ExitCode.Internal, changes: [] };
    try {
      outcome = await runOne(project, task, args, io, err);
    } catch (error) {
      outcome = { id: task.id, name: task.name, status: 'failed', summary: messageOf(error), exitCode: ExitCode.Internal, changes: [] };
      err(note(outcome.summary));
    } finally {
      try {
        await project.close();
      } catch (error) {
        err(note(`the project could not be closed cleanly: ${messageOf(error)}`));
        if (outcome.exitCode === ExitCode.Ok) outcome = { ...outcome, exitCode: ExitCode.Internal };
      }
    }
    outcomes.push(outcome);
    if (outcome.exitCode !== ExitCode.Ok && firstBad === ExitCode.Ok) firstBad = outcome.exitCode;
    state = withHandled(state, task.id, now().toISOString());
    try {
      await saveTaskState(statePath, state);
    } catch (error) {
      err(note(`the run is recorded in the project but the state file could not be written: ${messageOf(error)}`));
      if (firstBad === ExitCode.Ok) firstBad = ExitCode.Internal;
    }
  }

  if (args.format === 'json') {
    out(`${JSON.stringify({ type: 'task-runs', version: 1, runs: outcomes.map(({ changes: _changes, ...rest }) => rest) }, null, 2)}\n`);
  } else {
    for (const outcome of outcomes) {
      out(`${outcome.id}  ${outcome.name}: ${outcome.status} — ${outcome.summary}\n`);
      if (outcome.changes.length > 0) out(`\n${printChanges(outcome.changes)}\n`);
    }
    if (outcomes.length === 0) out(args.due ? 'Nothing was due.\n' : 'Nothing ran.\n');
    if (!args.write && outcomes.some((outcome) => outcome.changes.length > 0)) err(note('nothing was written: pass --write to save the changes'));
  }
  return firstBad;
}
