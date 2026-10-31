/**
 * `caotang scan`: the deterministic continuity checks over a project folder, for a writer's own CI (coherence.md §9.1).
 *
 * The scan calls no model and reads no key, so it takes no provider and no environment variable. The folder is opened through the
 * SDK's `NodeArtifactFs`, which refuses a link that leaves the folder, wrapped so that without `--write` any write is an error:
 * the folder is byte-identical afterwards. With `--write` the folder's single-writer lock is taken first, as `caotang agent` does.
 *
 * Stdout carries the chosen format and nothing else; the notes go to stderr. The exit code is 0, 7 when an open finding is at or
 * above `--fail-on`, or 8 when there is no such finding but a file was not UTF-8 text and went unchecked; 1, 2 and 3 are this
 * command's own failures, as for `caotang agent`. Without `--write`, `--summary` must name a file outside the project folder.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { loadInkCompiler } from '@caotang/mcp-server';
import { formatMarkdown, formatScan, runScan } from '@caotang/scan';
import { LOCK_FILE, NodeArtifactFs, ProjectLockedError, acquireProjectLock, dialogueFactsOf, manifestOnDisk, type ProjectLock } from '@caotang/sdk/folder';
import { ArtifactNotFoundError, type ArtifactFs } from '@caotang/store';

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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether `target` is the folder or a path inside it. `relative` copes with a trailing separator and, on Windows, with case and drive letters. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

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

/** Runs the command line to completion and returns the exit code. It loads the Ink compiler itself (idempotent), so a host need not. */
export async function runScanCommand(argv: readonly string[], io: ScanIo): Promise<number> {
  // The dialogue checks compile Ink synchronously, so the compiler loads before the project is opened.
  await loadInkCompiler();
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
  } catch (error) {
    io.stderr(note(`no Caotang project at ${root}: the folder could not be opened (${messageOf(error)})`));
    return ExitCode.Usage;
  }
  if ((await manifestOnDisk(fs)) === undefined) {
    // `manifestOnDisk` keeps its retry for a file another program has open, but does not say why it gave up.
    let cause: unknown;
    try {
      await fs.read('caotang.json');
    } catch (error) {
      cause = error;
    }
    if (cause !== undefined) {
      io.stderr(
        note(
          cause instanceof ArtifactNotFoundError
            ? `no Caotang project at ${root}: there is no caotang.json in it. Use --project <dir> to name the folder`
            : `no Caotang project at ${root}: caotang.json could not be read (${messageOf(cause)})`,
        ),
      );
      return ExitCode.Usage;
    }
  }

  const summaryTarget = args.summary === undefined ? undefined : resolve(io.cwd, args.summary);
  if (!args.write && summaryTarget !== undefined && isInside(root, summaryTarget)) {
    io.stderr(note('--summary must not write inside the project folder without --write. Name a file outside it, or pass --write'));
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
    if (result.unread.length > 0) io.stderr(note(`${result.unread.length} file(s) are not UTF-8 text and were not checked: ${result.unread.join(', ')}`));
    if (result.skipped.length > 0) io.stderr(note('this was a partial scan; the notes say which checks did not run'));
    else if (result.status === 'partial') io.stderr(note('this was a partial scan'));
    if (args.write) io.stderr(note('coherence.json was saved'));
    if (summaryTarget !== undefined) {
      // The step summary is shared by the steps of a job, so it is appended to; any other file is replaced.
      const stepSummary = io.env['GITHUB_STEP_SUMMARY'];
      const shared = stepSummary !== undefined && stepSummary !== '' && resolve(io.cwd, stepSummary) === summaryTarget;
      try {
        await (shared ? appendFile : writeFile)(summaryTarget, formatMarkdown(result), 'utf8');
      } catch (error) {
        // The scan finished, so its exit 7 or 8 stays; a clean scan with no report is still a failure.
        io.stderr(note(`could not write the summary to ${summaryTarget}: ${messageOf(error)}`));
        return result.exitCode !== 0 ? result.exitCode : ExitCode.Internal;
      }
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof ProjectLockedError) {
      io.stderr(note(`${error.message}. The lock is ${LOCK_FILE} in that folder.`));
      return ExitCode.Locked;
    }
    io.stderr(note(messageOf(error)));
    return ExitCode.Internal;
  } finally {
    await lock?.release();
  }
}
