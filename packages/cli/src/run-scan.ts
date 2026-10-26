/**
 * `caotang scan`: the deterministic continuity checks over a project folder, for a writer's own CI (coherence.md §9.1).
 *
 * The scan calls no model and reads no key, so it takes no provider and no environment variable. The folder is opened through the
 * SDK's `NodeArtifactFs`, which refuses a link that leaves the folder, wrapped so that without `--write` any write is an error:
 * the folder is byte-identical afterwards. With `--write` the folder's single-writer lock is taken first, as `caotang agent` does.
 *
 * Stdout carries the chosen format and nothing else; the notes go to stderr. The exit code is 0, or 7 when an open finding is at or
 * above `--fail-on`; 1, 2 and 3 are this command's own failures, as for `caotang agent`.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { formatMarkdown, formatScan, runScan } from '@caotang/scan';
import { LOCK_FILE, NodeArtifactFs, ProjectLockedError, acquireProjectLock, dialogueFactsOf, manifestOnDisk, type ProjectLock } from '@caotang/sdk/folder';
import type { ArtifactFs } from '@caotang/store';

import { UsageError } from './agent-args.js';
import { ExitCode } from './output.js';
import { SCAN_USAGE, parseScanArgs } from './scan-args.js';

export interface ScanIo {
  readonly env: NodeJS.ProcessEnv;
  /** Relative paths (`--project`, `--summary`) are resolved against it. */
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const note = (text: string): string => `caotang scan: ${text}\n`;

/** The folder's port with every write refused: a read-only scan cannot change a byte, whatever the code under it does. */
function readOnly(fs: NodeArtifactFs): ArtifactFs {
  const refuse = (): Promise<never> => Promise.reject(new Error('the scan was asked to write the folder without --write'));
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

/** Runs the command line to completion and returns the exit code. */
export async function runScanCommand(argv: readonly string[], io: ScanIo): Promise<number> {
  let args;
  try {
    args = parseScanArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${note(error.message)}\n${SCAN_USAGE}`);
    return ExitCode.Usage;
  }
  if (args === 'help') {
    io.stdout(SCAN_USAGE);
    return ExitCode.Ok;
  }

  const root = resolve(io.cwd, args.project ?? '.');
  let fs: NodeArtifactFs;
  try {
    fs = new NodeArtifactFs(root);
  } catch {
    io.stderr(note(`no Caotang project at ${root}: the folder cannot be opened`));
    return ExitCode.Usage;
  }
  if ((await manifestOnDisk(fs)) === undefined) {
    io.stderr(note(`no Caotang project at ${root}: there is no caotang.json in it. Use --project <dir> to name the folder`));
    return ExitCode.Usage;
  }

  let lock: ProjectLock | undefined;
  try {
    if (args.write) lock = await acquireProjectLock(root);
    const result = await runScan(
      args.write ? fs : readOnly(fs),
      { scope: args.scope, failOn: args.failOn, write: args.write, ...(args.checks === undefined ? {} : { checks: args.checks }) },
      { dialogueFacts: dialogueFactsOf },
    );
    io.stdout(formatScan(result, args.format));
    if (args.summary !== undefined) {
      const target = resolve(io.cwd, args.summary);
      // The step summary is shared by the steps of a job, so it is appended to; any other file is replaced.
      const stepSummary = io.env['GITHUB_STEP_SUMMARY'];
      const shared = stepSummary !== undefined && stepSummary !== '' && resolve(io.cwd, stepSummary) === target;
      await (shared ? appendFile : writeFile)(target, formatMarkdown(result), 'utf8');
    }
    if (result.unread.length > 0) io.stderr(note(`${result.unread.length} file(s) are not UTF-8 text and were not checked: ${result.unread.join(', ')}`));
    if (result.status === 'partial') io.stderr(note('this was a partial scan; the notes say which checks did not run'));
    if (args.write) io.stderr(note('coherence.json was saved'));
    return result.exitCode;
  } catch (error) {
    if (error instanceof ProjectLockedError) {
      io.stderr(note(`${error.message}. The lock is ${LOCK_FILE} in that folder.`));
      return ExitCode.Locked;
    }
    io.stderr(note(error instanceof Error ? error.message : String(error)));
    return ExitCode.Internal;
  } finally {
    await lock?.release();
  }
}
