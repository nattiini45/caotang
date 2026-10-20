/**
 * Artifact write path — [project-format.md §4](docs/architecture/project-format.md).
 *
 * §4 in full: "assemble the full folder in memory → write via temp name →
 * atomic rename". The folder is already assembled — {@link ProjectState} *is*
 * the assembled folder — so the job here is the part that is allowed to touch
 * files, plus the rolling manifest snapshots that make a torn or truncated
 * manifest recoverable.
 *
 * Two ordering rules are load-bearing and are the reason this function exists
 * rather than a `save()` on the state object:
 *
 *   1. Documents and codex redundancy files are written *before* the manifest. A
 *      crash between the two leaves orphan `docs/*.md` / `codex/*.md` files,
 *      which §2 step 4 imports as "Recovered" rather than discards. The reverse
 *      order would leave a manifest pointing at files that do not exist — a
 *      fatal load, not a recoverable one. The removal of a deleted document's
 *      file is the one thing that waits for the manifest (rule 3).
 *   2. The previous manifest is rotated *before* `caotang.json` is overwritten,
 *      which is the whole mechanism the §5 recovery ladder walks.
 *   3. A body whose text the file already holds is not written again, and a
 *      deleted document's file is removed only after the manifest that stops
 *      naming it has been written. So a crash between the two leaves at most an
 *      orphan file, which the next load recovers. A codex file follows the same
 *      changed-only rule as a body.
 *   4. When the caller holds the digests of the project files (`expectedDigests`,
 *      folder-digests.ts), each file is checked against its digest just before it
 *      is written or removed, and a file another program changed stops the write
 *      with `FolderDriftError`. The check is per file, so a change made after the
 *      caller's own check and before this write is not overwritten either.
 */

import { ArtifactNotFoundError, type ArtifactFs } from './artifact-fs.js';
import { serializeManifest } from './manifest-json.js';
import { PRODUCTION_FORMAT, type FormatContext } from './migrations.js';
import { serializeDocumentFile } from './document-file.js';
import { codexFile, serializeCodexFile, type CodexFrontMatter } from './codex-file.js';
import {
  BODY_EXTENSIONS,
  CODEX_DIR,
  DOCS_DIR,
  EXPORTS_DIR,
  GITIGNORE_FILE,
  MANIFEST_FILE,
  SNAPSHOT_COUNT,
  bodyFile,
  bodyNamesOf,
  bodyStemOf,
  isBodyFileName,
  isBodyType,
  legacyBodyNamesOf,
  snapshotFile,
} from './paths.js';
import { isIdWithPrefix } from '@caotang/ids';
import { digestOfFile, type DigestReader } from './folder-digests.js';
import type { ProjectState } from './state.js';
import type { CodexEntry, TreeNode } from './manifest.js';

export {
  CODEX_DIR,
  DOCS_DIR,
  EXPORTS_DIR,
  GITIGNORE_FILE,
  LEGACY_SNAPSHOT_FILE,
  MANIFEST_FILE,
  SESSIONS_FILE,
  SNAPSHOT_COUNT,
  docFile,
  snapshotFile,
} from './paths.js';

export interface WriteOptions {
  /** Stamped onto `project.modifiedAt`; defaults to now. */
  now?: Date;
  /** Override the snapshot depth (tests). Defaults to {@link SNAPSHOT_COUNT}. */
  snapshotCount?: number;
  /** Line ending for the files this writer creates. Bodies are never touched. */
  newline?: '\n' | '\r\n';
  /**
   * The only documents this write may remove from `docs/`. Absent, every `docs/` file the
   * manifest does not own is removed, which is right for a folder this writer owns outright.
   * A save into a folder another writer may also write (the desktop's Save to folder, which shares
   * the folder with the MCP server, and that server's `doc.import`) names only the documents the
   * session itself deleted, so a file it did not write is never removed.
   */
  pruneDocumentIds?: readonly string[];
  /**
   * The digest of each project file this writer held, by path (folder-digests.ts): what the folder held when the caller last read it or
   * wrote it. Before a document, codex or legacy file is written or removed, its digest on disk is compared with the one here, and a
   * difference stops the write with {@link FolderDriftError} before that file is touched. A path the map does not name is expected absent.
   * Absent, nothing is checked: the caller has no copy of the folder to check against. The caller checks the whole folder first, so
   * this check only sees a change that happens during the write.
   */
  expectedDigests?: ReadonlyMap<string, string>;
  /**
   * How the {@link expectedDigests} check reads a file's digest. Absent, it reads the file once (`digestOfFile`). A caller whose file system
   * can report another program's brief hold on a file passes a reader that retries one, so that hold is not taken for a change.
   */
  readDigest?: DigestReader;
  /**
   * The report this write fills in as it goes, instead of a new one: a caller whose write fails part way reads what was already written,
   * rotated or removed, and keeps the digests of exactly those files (folder-digests.ts `digestsAfterWrite`). Pass an empty report.
   */
  report?: WriteReport;
  /**
   * Who this copy is for, which decides what the write does with a file the
   * load declined because its bytes are not UTF-8 text — a `codex/<id>.md`
   * file, or a document body.
   *
   * A **`user`** copy (the default) is one the writer takes home, so it has to
   * be able to carry the whole project: such a file has no text to write, so a
   * copy that cannot hold it refuses rather than shipping a project without it.
   * A save in place is never affected — the folder holds the file, and the
   * write leaves it exactly as it is.
   *
   * An **`internal`** copy is one the app keeps for itself: the desktop's
   * safety bundle, which holds a browser's copy in memory so that a failed
   * adopt can put it back. It is not the writer's backup, so it mirrors what
   * the state holds rather than refusing: a codex file the load could not read
   * has no entry and no text, so the copy leaves it out; a document the load
   * held has no body, so the copy writes the empty body it shows. Both are
   * named in the report, and the author's own file is never touched.
   */
  copyFor?: 'user' | 'internal';
  /**
   * Which version this build writes — the same context the project was loaded
   * with. Defaults to the production one, and nothing in this package passes
   * anything else; it is here so a test can drive the writer at a version above
   * `FORMAT_VERSION` without bumping the constant.
   */
  format?: FormatContext;
}

export interface WriteReport {
  /** Every path the write touched, sorted. */
  written: string[];
  /** Snapshot paths that were created by rotation, newest first. */
  rotated: string[];
  /** Snapshot paths that fell off the end of the ladder. */
  dropped: string[];
  /**
   * Files whose text this copy does not carry, because the load declined them
   * and their bytes are not text. Only an `internal` copy has any
   * (`WriteOptions.copyFor`); a `user` copy refuses instead of making one.
   */
  omitted?: string[];
  /** `codex/<id>.md` files removed because no manifest entry owns them any more. */
  pruned: string[];
}

/**
 * A write stopped because a project file changed on disk after the caller held its digest (`WriteOptions.expectedDigests`). The file
 * named in `paths` was not written or removed, and nothing after it was. `partial` is what the write had already done before it stopped,
 * so the caller can keep the digests of those files and report the rest. The paths are for the caller's log: a refusal shown to a writer
 * names documents and codex entries by their titles and names, not by file.
 */
export class FolderDriftError extends Error {
  constructor(
    readonly paths: readonly string[],
    readonly partial: WriteReport,
  ) {
    super(`a project file changed on disk during the save, so the save stopped before it: ${paths.join(', ')}`);
    this.name = 'FolderDriftError';
  }
}

/**
 * The redundancy copy of a node's metadata that goes at the top of its file.
 * Structure is deliberately absent: `parentId`/`order` in front matter would
 * force a doc-file rewrite on every drag (§3's rejected alternative).
 */
function frontMatterFor(node: TreeNode) {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    label: node.label,
    keywords: node.keywords,
    synopsis: node.synopsis,
  };
}

/**
 * The redundancy copy of a codex entry — [codex.md §3](docs/architecture/codex.md).
 *
 * The nine keys codex.md §3 lists, in its order, and the two provenance keys
 * codex.md §10 K4 adds after them. Provenance is written here because a recovery
 * from this file must not reverse it: an agent-inferred entry recovered from its
 * redundancy file would otherwise come back as hand-authored canon (codex.md §2,
 * coherence.md §4.3). Timestamps stay absent, since no spec key carries them.
 */
function codexFrontMatterFor(entry: CodexEntry): CodexFrontMatter {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    includePolicy: entry.includePolicy,
    caseSensitive: entry.caseSensitive,
    aliases: entry.aliases,
    exclude: entry.exclude,
    attachments: entry.attachments,
    keywords: entry.keywords,
    ...(entry.visualRefs === undefined ? {} : { visualRefs: entry.visualRefs }),
    origin: entry.origin,
    sources: entry.sources,
  };
}

/**
 * Rotate the manifest snapshots one generation down and put the current
 * manifest in `bak.1`. The oldest generation falls off — depth 3 is a
 * deliberate bound, not an oversight.
 *
 * **Only a manifest that is genuinely absent means "first write".** Every other
 * read failure — a locked file, a permission error, a broken disk — is not
 * evidence that there is nothing to rotate, and reading it that way overwrote
 * `caotang.json` with no snapshot of it: the one loss the §5 recovery ladder
 * exists to prevent, caused by the ladder's own first step. A read that fails
 * for any other reason therefore **refuses the save**: the manifest on disk is
 * still there, and the caller is told why the save did not happen.
 */
async function rotateManifest(
  fs: ArtifactFs,
  depth: number,
  report: WriteReport,
): Promise<void> {
  let previous: string;
  try {
    previous = await fs.read(MANIFEST_FILE);
  } catch (cause) {
    // `ArtifactNotFoundError` is the port's one "there is no such file" signal,
    // and every backend raises it for an absent path (artifact-fs.ts).
    if (cause instanceof ArtifactNotFoundError) {
      // First write into this folder: no previous manifest to rotate.
      return;
    }
    throw cause;
  }

  const oldest = snapshotFile(depth);
  if (await fs.exists(oldest)) {
    await fs.remove(oldest);
    report.dropped.push(oldest);
  }
  for (let n = depth - 1; n >= 1; n -= 1) {
    const from = snapshotFile(n);
    if (!(await fs.exists(from))) continue;
    await fs.writeAtomic(snapshotFile(n + 1), await fs.read(from));
    report.rotated.push(snapshotFile(n + 1));
  }

  await fs.writeAtomic(snapshotFile(1), previous);
  report.rotated.push(snapshotFile(1));
}

/** Whether `path` already holds exactly `text`. A file that cannot be read is not held, so the writer writes it. */
async function holdsText(fs: ArtifactFs, path: string, text: string): Promise<boolean> {
  try {
    return (await fs.read(path)) === text;
  } catch {
    return false;
  }
}

/**
 * Write the whole artifact.
 *
 * `sessions.jsonl` is not written here. `writeProject` takes a `ProjectState`, and the session log is not project state, so it has
 * nothing to write the file from. The file is written beside it by `writeSessionsFile` (sessions.ts), which only ever appends
 * (project-format §4): the folder save and the bundle export both call it with the runtime store's lines, so an artifact write is
 * never a rewrite of the log.
 */
export async function writeProject(
  fs: ArtifactFs,
  state: ProjectState,
  options: WriteOptions = {},
): Promise<WriteReport> {
  const now = options.now ?? new Date();
  const depth = options.snapshotCount ?? SNAPSHOT_COUNT;
  const newline = options.newline ?? '\n';
  const format = options.format ?? PRODUCTION_FORMAT;
  const copyFor = options.copyFor ?? 'user';
  const report: WriteReport = options.report ?? { written: [], rotated: [], dropped: [], pruned: [] };
  const expected = options.expectedDigests;
  const readDigest: DigestReader = options.readDigest ?? ((path) => digestOfFile(fs, path));
  // The check the caller asked for (expectedDigests): a project file another program changed since the caller held it is not written
  // or removed. The write stops here, before that file, and the report says what was already done.
  const guard = async (path: string): Promise<void> => {
    if (expected === undefined) return;
    if ((await readDigest(path)) !== expected.get(path)) throw new FolderDriftError([path], report);
  };

  state.manifest.project.modifiedAt = now.toISOString();

  await fs.ensureDir(DOCS_DIR);
  await fs.ensureDir(CODEX_DIR);
  await fs.ensureDir(EXPORTS_DIR);

  // 1. Documents first (§4 ordering rule 1).
  for (const node of state.manifest.tree) {
    if (!isBodyType(node.type)) continue;
    const record = state.documents.get(node.id);
    if (!record) {
      // A body the load held because its bytes are not UTF-8 (read.ts; state.ts
      // `declinedDocFiles`). The state has no text for it, so the writer must not
      // write one. Where the target already holds the file, the file is left as it
      // is, which is what a save in place should do. Where it does not, an empty
      // document would be written over nothing the user can recover, so the write
      // is refused: an export of such a project fails loudly rather than shipping a
      // blank chapter.
      const declined = bodyNamesOf(node).find((name) => state.declinedDocFiles.has(name));
      if (declined !== undefined) {
        if (await fs.exists(`${DOCS_DIR}/${declined}`)) continue;
        if (copyFor === 'internal') {
          // An internal copy mirrors what the state holds (write.ts
          // `WriteOptions.copyFor`): the load held this document, so the copy
          // writes the empty body the browser's own copy shows. Without a file
          // at all the copy would name a document it does not hold, and the
          // next load of it would be a fatal one. The author's file stays where
          // it is.
          const target = bodyFile(node);
          const text = node.type === 'dialogue' ? '' : serializeDocumentFile(frontMatterFor(node), '', { newline });
          await guard(target);
          await fs.writeAtomic(target, text);
          report.written.push(target);
          (report.omitted ??= []).push(`${DOCS_DIR}/${declined}`);
          continue;
        }
        // Named by title, in the writer's words: the file is the writer's, and the project folder still holds it.
        throw new Error(
          `the document “${node.title}” is not UTF-8 text, so Caotang cannot write it into this copy, and it will not write an empty document in its place. The file it was opened from still holds its text, and Caotang has not changed it.`,
        );
      }
      throw new Error(`document node "${node.id}" has no body record; refusing to write`);
    }
    const target = bodyFile(node);
    // An Ink body is written whole, because Ink has no front matter (dialogue-narrative.md §2.2). Every other body
    // carries the front matter project-format.md §3 gives it, and a screenplay's `.fountain` file too (screenplay.md §2.1).
    const text =
      node.type === 'dialogue'
        ? newline === '\n'
          ? record.body
          : record.body.replace(/\n/g, newline)
        : serializeDocumentFile(frontMatterFor(node), record.body, { newline });
    // A body the file already holds is not written again (project-format §4): a save writes the documents that changed, so it never
    // rewrites a document another program may have edited since this copy read it.
    if (!(await holdsText(fs, target, text))) {
      await guard(target);
      await fs.writeAtomic(target, text);
      report.written.push(target);
    }
    // The `.md` a save wrote before this kind had a file of its own is removed once the kind's file is in place (project-format.md
    // §3). The load reads the kind's file first, so the older copy is never read again while the node exists, and leaving it would
    // keep a second body beside the first. A file the load declined is the author's, and is left where it is (state.ts).
    for (const legacy of legacyBodyNamesOf(node)) {
      const path = `${DOCS_DIR}/${legacy}`;
      if (state.declinedDocFiles.has(legacy)) continue;
      if (!(await fs.exists(path))) continue;
      await guard(path);
      await fs.remove(path);
      report.pruned.push(path);
    }
  }

  // 2. Codex redundancy files (codex.md §3) — "written on every entry save via
  //    the same atomic write path as documents", and before the manifest for the
  //    same reason documents are: a crash in between leaves an orphan file that
  //    §2 step 4 imports, never a manifest entry pointing at nothing. Like a body,
  //    a codex file the folder already holds with this text is not written again
  //    (project-format §4, the changed-only rule).
  const codex = state.manifest.codex;
  if (codex !== undefined) {
    for (const entry of codex) {
      const path = codexFile(entry.id);
      const text = serializeCodexFile(codexFrontMatterFor(entry), entry.description, { newline });
      if (await holdsText(fs, path, text)) continue;
      await guard(path);
      await fs.writeAtomic(path, text);
      report.written.push(path);
    }
    await pruneCodexFiles(fs, codex, state.declinedCodexFiles, guard, report);
  }

  // 2b. Files the load declined (state.ts `declinedText`). The loader kept each one
  //     on disk and recorded its text, so a target that does not hold the file gets
  // the recorded text — which is what keeps an export lossless. A target
  //     that already holds it keeps its own bytes: a save in place never rewrites one.
  for (const [path, text] of state.declinedText) {
    if (await fs.exists(path)) continue;
    await guard(path);
    await fs.writeAtomic(path, text);
    report.written.push(path);
  }

  // 2c. A codex file the load declined *because its bytes are not UTF-8*.
  //
  //     The case above cannot cover it: there is no text to record for a file
  //     that is not text, so nothing travels with the state and a target that
  //     does not hold the file would simply not get it. The document refusal in
  //     step 1 is the same hole closed for `docs/`, and the export is where it
  //     bit: `exportProjectZip` assembles into a *fresh* folder, so the bundle
  //     left the file out with no error at all — the one loss codex.md §3 calls
  //     "the direct countermeasure to the Manuskript corpus".
  //
  //     So the codex case refuses the same way the document case does: a save
  //     in place leaves the author's file exactly as it is, and a copy that
  //     cannot hold the file refuses rather than losing it quietly.
  for (const name of state.declinedCodexFiles) {
    const path = codexFile(name.slice(0, -3));
    // Its text travels with the state (step 2b), so this copy can hold it.
    if (state.declinedText.has(path)) continue;
    // The target already holds the file: a save in place never rewrites one.
    if (await fs.exists(path)) continue;
    if (copyFor === 'internal') {
      // An internal copy (write.ts `WriteOptions.copyFor`) is not the writer's
      // backup, so it mirrors what the state holds: the load could not read
      // this file, so the copy has no entry for it and no text to write, and
      // it says so in the report rather than refusing. The author's file stays
      // where it is.
      (report.omitted ??= []).push(path);
      continue;
    }
    throw new Error(
      `the codex file “${path}” is not UTF-8 text, so Caotang cannot write it into this copy, and it will not leave it out of it. The file it was opened from still holds its text, and Caotang has not changed it.`,
    );
  }

  // 3. `.gitignore` — created only when absent. An artifact that a writer has
  //    customized is the author's file, and silently replacing it is the one
  //    thing this whole module must never do.
  if (!(await fs.exists(GITIGNORE_FILE))) {
    await fs.writeAtomic(GITIGNORE_FILE, 'exports/\n');
    report.written.push(GITIGNORE_FILE);
  }

  // 4. Serialize, then rotate, then overwrite the manifest (§4 ordering rule 2).
  //
  // Serialization comes first deliberately, and what it buys is the *rotation*
  // specifically: `serializeManifest` refuses a manifest whose `formatVersion` is
  // not this build's (§6 — see the note in `manifest-json.ts`), and a refusal
  // that arrived after the rotation would have already shifted `caotang.json` into
  // `bak.1` — a write that changed the folder's recovery ladder and then refused
  // to write. Putting the serialization ahead of it buys exactly that.
  //
  // **It is not the first thing that can fail, and a refusal is not free.**
  // Steps 1–3 have already run by the time the
  // serializer is called — three directories created, every changed document
  // body written, codex files rewritten and **pruned**, `.gitignore` created. So a
  // refused write still reaches disk: a body lands and an un-owned codex file is
  // deleted, with the manifest and the ladder untouched. Deleted documents'
  // files are not among them: they are removed after the manifest (step 5). Measured in `test/migration-path.test.ts`
  // ("a refused write is not free"); hoisting the check above the writes is a separate change.
  const manifestText = serializeManifest(state.manifest, format);
  await rotateManifest(fs, depth, report);
  await fs.writeAtomic(MANIFEST_FILE, manifestText);
  report.written.push(MANIFEST_FILE);

  // 5. Documents the save deleted (§3, the folder-save rule). They go after the manifest, not with the body writes: the manifest
  //    that stops naming a document must land first, so a failure between the two leaves an orphan file that the next load imports as
  //    Recovered, and never a manifest naming a file that is gone (§4's "fatal load").
  await pruneDocFiles(fs, state, options.pruneDocumentIds, guard, report);

  report.written.sort();
  report.rotated.sort();
  report.dropped.sort();
  report.pruned.sort();
  report.omitted?.sort();
  return report;
}

/**
 * Remove `codex/<id>.md` files that no manifest entry owns any more.
 *
 * codex.md §3's conflict rule is "manifest wins over redundancy files; missing
 * file → rewritten from manifest; file with no manifest entry → recovered like
 * orphan `docs/*.md`". The third clause is about a *loaded* folder whose
 * manifest is intact but has lost the pairing — the loader imports those, and by
 * the time anything is written they are in the manifest. What is *intended* to be
 * left after that is a file whose entry the author deleted, and leaving it behind
 * would make the §5.4 rebuild resurrect the deletion it was supposed to preserve.
 *
 * Two deliberate limits, both because the rule above ends in "never deleted":
 * only files whose stem is a syntactically valid codex id are touched (anything
 * else in `codex/` is an unknown file, §1), and the whole pass is skipped
 * unless the manifest actually carries a `codex` array — an absent array means
 * the codex was never loaded into this state, which is not evidence that the
 * folder is empty.
 *
 * **What the loader declined, this function does not own**. A `codex/<valid c_ id>.md` whose front
 * matter does not parse is reported at load and left un-imported, which makes it
 * un-owned here for exactly the reason a deleted entry is — so before this
 * slice the next save deleted it, and what it deleted was the only copy of a
 * hand-written description. codex.md §3 *invites* the hand edit (it puts
 * `description` in the body "so the entry reads as prose in any Markdown
 * viewer") and names this file "the direct countermeasure to the Manuskript
 * corpus (single-asset corruption = unreadable project)" — the thing this
 * function used to destroy first. `docs/*.md` never had the hole: the loader
 * imports an unparseable orphan as a Recovered document with its bytes kept
 * whole, and no prune pass touches `docs/` at all, which is why the asymmetry
 * was the evidence that this is a defect and not a policy.
 *
 * The decision is made **once, at load**, by the code that actually read the
 * file — `readProject` records the names on `state.declinedCodexFiles` — and
 * only honoured here. Re-deriving "can this file be imported?" in this function
 * instead would be a second opinion about a rule that lives in the reader, and
 * the two would drift exactly the way §9's Params column and the accepted-key
 * lists did.
 *
 * The *other* un-owned file is one whose front matter names a different id than
 * its filename, and it is still pruned, deliberately: its text was imported
 * under the id the front matter carries and is written back at that id during
 * this same save, so nothing is lost — while leaving the stray file would make a
 * §5.4 rebuild import it a second time, as a duplicate of the entry that owns
 * its text. The load notice says so before it happens.
 *
 * ⚠ **What this skip buys is a file in *this* folder, and it is not by itself a
 * guarantee that survives an export.** `exportProjectZip` assembles into a
 * *fresh* `MemoryArtifactFs`, so a declined file is in neither the folder the
 * export reads nor the state the export writes from. What the export does with
 * it is decided by the write path itself (`writeProject`, steps 2b and 2c): a
 * file whose text the load could read travels with the state and is carried
 * into the bundle, and a file whose bytes are not UTF-8 — the one case with no
 * text to carry — makes the export **refuse** rather than ship a bundle that
 * quietly left the file out.
 */
async function pruneCodexFiles(
  fs: ArtifactFs,
  codex: readonly CodexEntry[],
  declined: ReadonlySet<string>,
  guard: (path: string) => Promise<void>,
  report: WriteReport,
): Promise<void> {
  const owned = new Set(codex.map((entry) => `${entry.id}.md`));
  const present = await fs.listFiles(CODEX_DIR);
  for (const name of present) {
    if (!name.endsWith('.md')) continue;
    if (!isIdWithPrefix('c', name.slice(0, -3))) continue;
    if (owned.has(name)) continue;
    if (declined.has(name)) continue;
    await guard(`${CODEX_DIR}/${name}`);
    await fs.remove(`${CODEX_DIR}/${name}`);
    report.pruned.push(`${CODEX_DIR}/${name}`);
  }
}

/**
 * The `docs/` twin of `pruneCodexFiles`, added — and the
 * **only** thing that makes `project.deleteNode` survive a reopen.
 *
 * Without it, a deleted document's file stays in the folder, and §2 step 4 does not
 * merely tolerate that: it *imports* the orphan as a "Recovered" document. So the
 * sequence a user would see is delete the scene, save, reopen — and the scene is
 * back, detached from its parent and stripped of the status and labels the tree
 * carried, because all of that lived in the manifest the deletion removed. A delete
 * that un-deletes itself on the next open is not a delete, and the gap was invisible
 * until there was a command that removes a node: nothing before `project.deleteNode`
 * could produce an un-owned `docs/` file.
 *
 * **It cannot destroy a hand-written file**, and the reason is the reader, not a
 * guard here. §2 step 4 imports *every* orphan `docs/*.md` — including an
 * unparseable one, "with its bytes kept whole" (`read.ts`) — so by the time anything
 * is written, a file the author put in `docs/` is a document in the manifest and
 * this pass sees it as owned. That is the same invariant `pruneCodexFiles` leans on,
 * and it is why this needs no "declined" set: the loader never declines a doc.
 *
 * A file whose stem is **not** a valid node id is never touched, which is §1's
 * unknown-files rule applied to the same loop: `docs/notes.md` is the
 * author's, and this folder is theirs.
 *
 * Unlike the codex skip, the guarantee is not per-folder. `exportProjectZip`
 * assembles into a *fresh* `MemoryArtifactFs`, so a deleted document's file is
 * absent there because it was never written — and the prune is inert there rather
 * than load-bearing, which is the one asymmetry between the two paths and is why
 * the zip case is tested separately rather than assumed.
 *
 * It runs after the manifest is written (step 5 of `writeProject`), so a crash
 * during the removal leaves an orphan body file and no manifest naming a missing one.
 */
async function pruneDocFiles(
  fs: ArtifactFs,
  state: ProjectState,
  only: readonly string[] | undefined,
  guard: (path: string) => Promise<void>,
  report: WriteReport,
): Promise<void> {
  // Every name a body node may carry: its kind's own file, and the `.md` a save wrote before the kind had one. A body
  // file under `docs/` that none of them names is a deleted node's body, whatever its extension. A `.fountain` or `.ink`
  // left behind would be imported again on the next open, as a node the binder never shows.
  const owned = new Set(
    state.manifest.tree.filter((node) => isBodyType(node.type)).flatMap((node) => bodyNamesOf(node)),
  );
  if (only !== undefined) {
    // The caller names the documents it deleted, so nothing else in `docs/` is at risk. The same two
    // refusals as the sweep below still hold: an owned file and a declined file are never removed.
    for (const id of only) {
      if (!isIdWithPrefix('n', id)) continue;
      // A deleted node's body may sit under any body extension: its kind's own, or the `.md` written before it had one.
      for (const ext of BODY_EXTENSIONS) {
        const name = `${id}.${ext}`;
        if (owned.has(name) || state.declinedDocFiles.has(name)) continue;
        const path = `${DOCS_DIR}/${name}`;
        if (!(await fs.exists(path))) continue;
        await guard(path);
        await fs.remove(path);
        report.pruned.push(path);
      }
    }
    return;
  }
  const present = await fs.listFiles(DOCS_DIR);
  for (const name of present) {
    if (!isBodyFileName(name)) continue;
    if (!isIdWithPrefix('n', bodyStemOf(name))) continue;
    if (owned.has(name)) continue;
    // A file the load declined is not a file the writer owns (state.ts).
    if (state.declinedDocFiles.has(name)) continue;
    await guard(`${DOCS_DIR}/${name}`);
    await fs.remove(`${DOCS_DIR}/${name}`);
    report.pruned.push(`${DOCS_DIR}/${name}`);
  }
}
