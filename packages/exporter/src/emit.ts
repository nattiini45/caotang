/**
 * Stage 4, emit — [exporter.md §2](../../../docs/architecture/exporter.md): the
 * artifact into `exports/`, and the append-only `exports/compile-log.json`.
 *
 * ## Why this is a queue and not a call
 *
 * The bus is synchronous (command-bus.md A2): an apply cannot await anything, and a
 * promise returned from an apply is refused. A compile, though, has an async part —
 * the DOCX and EPUB renderers are dynamically imported, and every `ArtifactFs` write
 * is a promise. So the apply does everything that is synchronous (flatten, the
 * digest, the output name) and hands the rest to this queue, which runs its jobs one
 * after another in the order they were queued. That is the same shape the store's
 * `SnapshotSink` takes for the same reason, and it is stated there too.
 *
 * Two consequences are the reason for the rest of the file:
 *
 * 1. **Order is the guarantee.** A removal queued by an undo runs after the write it
 *    undoes, and a write queued by a later compile runs after that removal. Nothing
 *    overtakes anything, so a fast undo-then-compile cannot leave a file behind.
 * 2. **A failed job is recorded, not swallowed.** The digest has already said where
 *    the artifact will be, so a job that fails writes a note into the compile log
 *    (which is itself the honest record) and lands in {@link Emitter.failures}.
 *
 * ## Names
 *
 * The output name is decided synchronously, so it must be checked against what is
 * already in `exports/` without awaiting. The emitter lists the folder once, when it
 * is created, and reserves names from then on. A compile dispatched before that
 * listing finishes is refused ({@link ExportNotReadyError}) rather than reserving a
 * name it cannot check. §2 says a collision gets an auto-versioned name, so the
 * second `The Lighthouse Keeper.md` becomes `The Lighthouse Keeper-2.md`.
 */

import { ArtifactNotFoundError, EXPORTS_DIR, type ArtifactFs } from '@caotang/store';
import { ExportNotReadyError } from './errors.js';
import { suffixName } from './template.js';
import { isBinaryFormat, type CompileLogEntry, type ExportFormat } from './types.js';

/** `exports/compile-log.json`, the append-only record of every compile (§2 stage 4). */
export const COMPILE_LOG_FILE = 'compile-log.json';
export const COMPILE_LOG_PATH = `${EXPORTS_DIR}/${COMPILE_LOG_FILE}`;

/**
 * Where binary artifacts go. `ArtifactFs` stores strings and a `.docx`, `.epub` or `.xlsx` is
 * a binary container, so writing one needs a binding that can hold bytes. The
 * binding is optional: without it the binary formats are compiled for download and
 * the bus refuses them (see `ExportUnavailableError`).
 */
export interface ByteArtifacts {
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  removeBytes(path: string): Promise<void>;
  /** Basenames already in `dir`, so the output-name reservation sees binary files too. */
  listFiles?(dir: string): Promise<string[]>;
}

export interface EmitFailure {
  /** The path the job was for, when it had one. */
  readonly path: string | null;
  readonly message: string;
}

/**
 * What a file's render gives back: its contents, or its contents with notes that belong in the compile log row. A render can learn
 * a note only by running (the EPUB cover's size is read from the cover, and the cover is read then), and the row is written after
 * the renders, so a note returned here reaches it.
 */
export type RenderedContents = Uint8Array | string | { readonly contents: Uint8Array | string; readonly notes: readonly string[] };

/** A render's contents and notes, with the notes empty when the render returned contents alone. */
export function splitRendered(rendered: RenderedContents): { readonly contents: Uint8Array | string; readonly notes: readonly string[] } {
  if (typeof rendered === 'string' || rendered instanceof Uint8Array) return { contents: rendered, notes: [] };
  return rendered;
}

/** One artifact of a compile: where it goes, what it is, and how to render it. */
export interface PublishedFile {
  readonly path: string;
  readonly format: ExportFormat;
  /** Rendering is async for DOCX and EPUB, so it runs inside the queue, in order. */
  readonly render: () => Promise<RenderedContents>;
}

/** A single-artifact compile: the rendered artifact, or the reason there is none. */
export interface PublishJob extends PublishedFile {
  /** The log row, minus `output`, which depends on whether the write succeeded. */
  readonly entry: Omit<CompileLogEntry, 'output' | 'outputs'>;
}

/** A compile that writes one or more artifacts. Either every file is written, or none is. */
export interface PublishFilesJob {
  readonly files: readonly PublishedFile[];
  /** The log row, minus `output` and `outputs`, which depend on whether the writes succeeded. */
  readonly entry: Omit<CompileLogEntry, 'output' | 'outputs'>;
}

export interface Emitter {
  /** Resolves once `exports/` has been listed. Writes queue behind it. */
  ready(): Promise<void>;
  /** Reserves the next free `exports/<base>.<ext>` synchronously. Throws before {@link ready} resolves. */
  reserve(base: string, ext: string): string;
  /**
   * Reserves a set of files' names together, synchronously, and returns each file with the path it was given.
   * Either every name is free as it stands, or the whole set takes the next suffix (`-2`, `-3`, …) so the files
   * of one compile stay paired. The names must be distinct within the set.
   */
  reserveGroup<T extends { readonly name: string }>(files: readonly T[]): (T & { readonly path: string })[];
  /** Queues a compile: render, write the artifact, append its log row. */
  publish(job: PublishJob): void;
  /** Queues a compile of several artifacts: render them all, write them all, or write none. */
  publishFiles(job: PublishFilesJob): void;
  /** Frees a path's reservation and queues the removal of what was written there. */
  restore(path: string): void;
  /** Frees each path's reservation and queues the removal of what was written there. */
  restoreAll(paths: readonly string[]): void;
  /** Resolves when every job queued so far has settled. Never rejects. */
  idle(): Promise<void>;
  /** Every failure so far, in the order the jobs ran. */
  failures(): readonly EmitFailure[];
}

export interface EmitterOptions {
  readonly artifacts: ArtifactFs;
  readonly bytes?: ByteArtifacts;
}

export function createEmitter(options: EmitterOptions): Emitter {
  const { artifacts, bytes } = options;
  const reserved = new Set<string>();
  const failed: EmitFailure[] = [];
  let primed = false;

  const listing = (async () => {
    for (const name of await artifacts.listFiles(EXPORTS_DIR)) reserved.add(`${EXPORTS_DIR}/${name}`);
    if (bytes?.listFiles !== undefined) {
      for (const name of await bytes.listFiles(EXPORTS_DIR)) reserved.add(`${EXPORTS_DIR}/${name}`);
    }
    primed = true;
  })();

  // The queue starts behind the listing, so no write can run before the folder has
  // been seen. A failed listing is recorded here and is what `ready()` rejects with;
  // it must not reach `idle()` as a rejection, which is documented never to reject.
  let tail: Promise<void> = listing.catch((error: unknown) => {
    failed.push({ path: EXPORTS_DIR, message: messageOf(error) });
  });
  const queue = (label: string, job: () => Promise<void>): void => {
    tail = tail.then(job).catch((error: unknown) => {
      failed.push({ path: label, message: messageOf(error) });
    });
  };

  /**
   * One compile's writes, as one queued job. Every file is rendered before the first is written, so a
   * renderer that fails leaves nothing behind. A write that fails takes the files written before it
   * with it, so a compile is never left half on disk, and its log row says it was not written.
   */
  function publishFiles(job: PublishFilesJob): void {
    const first = job.files[0]?.path ?? COMPILE_LOG_PATH;
    queue(first, async () => {
      const notes = [...job.entry.notes];
      const written: string[] = [];
      try {
        const rendered: { readonly file: PublishedFile; readonly contents: Uint8Array | string }[] = [];
        for (const file of job.files) {
          const out = splitRendered(await file.render());
          notes.push(...out.notes);
          rendered.push({ file, contents: out.contents });
        }
        for (const { file, contents } of rendered) {
          await writeArtifact(file.path, file.format, contents);
          written.push(file.path);
        }
      } catch (error) {
        const reason = messageOf(error);
        for (const path of written.splice(0)) {
          try {
            await removeArtifact(path);
          } catch (cleanup) {
            failed.push({ path, message: messageOf(cleanup) });
          }
        }
        notes.push(`artifact not written: ${reason}`);
        failed.push({ path: first, message: reason });
      }
      try {
        await appendLog({
          ...job.entry,
          output: written[0] ?? null,
          ...(written.length > 1 ? { outputs: [...written] } : {}),
          notes,
        });
      } catch (error) {
        failed.push({ path: COMPILE_LOG_PATH, message: messageOf(error) });
      }
    });
  }

  function restoreAll(paths: readonly string[]): void {
    for (const path of paths) {
      reserved.delete(path);
      queue(path, () => removeArtifact(path));
    }
  }

  return {
    ready: () => listing,

    reserve(base, ext) {
      if (!primed) throw new ExportNotReadyError();
      let candidate = `${EXPORTS_DIR}/${base}.${ext}`;
      for (let n = 2; reserved.has(candidate); n += 1) {
        candidate = `${EXPORTS_DIR}/${base}-${n}.${ext}`;
      }
      reserved.add(candidate);
      return candidate;
    },

    reserveGroup(files) {
      if (!primed) throw new ExportNotReadyError();
      if (new Set(files.map((file) => file.name)).size !== files.length) {
        throw new Error('a compile named two of its files the same, so the set cannot be reserved without an overwrite');
      }
      for (let n = 1; ; n += 1) {
        const placed = files.map((file) => ({ file, path: `${EXPORTS_DIR}/${n === 1 ? file.name : suffixName(file.name, n)}` }));
        if (placed.every(({ path }) => !reserved.has(path))) {
          for (const { path } of placed) reserved.add(path);
          return placed.map(({ file, path }) => ({ ...file, path }));
        }
      }
    },

    publish(job) {
      publishFiles({ files: [{ path: job.path, format: job.format, render: job.render }], entry: job.entry });
    },

    publishFiles,

    restore(path) {
      restoreAll([path]);
    },

    restoreAll,

    async idle() {
      await tail;
    },

    failures: () => [...failed],
  };

  async function writeArtifact(path: string, format: ExportFormat, contents: Uint8Array | string): Promise<void> {
    await artifacts.ensureDir(EXPORTS_DIR);
    if (isBinaryFormat(format)) {
      if (bytes === undefined) throw new Error(`no byte binding is attached, so ${path} cannot be written`);
      if (typeof contents === 'string') throw new Error(`${format} rendered as text, which is a renderer defect`);
      await bytes.writeBytes(path, contents);
      return;
    }
    if (typeof contents !== 'string') throw new Error(`${format} rendered as bytes, which is a renderer defect`);
    await artifacts.writeAtomic(path, contents);
  }

  async function removeArtifact(path: string): Promise<void> {
    if (isBinaryPath(path)) {
      if (bytes !== undefined) await bytes.removeBytes(path);
      return;
    }
    await artifacts.remove(path);
  }

  /**
   * Appends one row. The file is rewritten whole, because `ArtifactFs` has no append,
   * but the rows already in it are never edited or dropped. A file that is not a JSON
   * array is refused rather than overwritten: a corrupt log is evidence, not scratch.
   */
  async function appendLog(entry: CompileLogEntry): Promise<void> {
    let rows: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(await artifacts.read(COMPILE_LOG_PATH));
      if (!Array.isArray(parsed)) {
        throw new Error(`${COMPILE_LOG_PATH} is not a JSON array, so it was not appended to`);
      }
      rows = parsed;
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }
    rows.push(entry);
    await artifacts.ensureDir(EXPORTS_DIR);
    await artifacts.writeAtomic(COMPILE_LOG_PATH, `${JSON.stringify(rows, null, 2)}\n`);
  }
}

/** A path whose artifact lives in the byte store: the extension of a binary format (DOCX, EPUB and the screenplay PDF). */
function isBinaryPath(path: string): boolean {
  return /\.(docx|epub|xlsx|pdf)$/i.test(path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
