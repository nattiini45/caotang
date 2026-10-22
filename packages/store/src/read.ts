/**
 * Artifact load path — [project-format.md §2 "Validation (load-time, in order)"](docs/architecture/project-format.md).
 *
 * The load-time order in §2 is reproduced exactly and is load-bearing: parse →
 * version gate → per-field schema → referential integrity. Stopping early on a
 * fatal step matters because each later step assumes the earlier one held.
 *
 * What is canonical where (§4): the file body is the irreplaceable content, the
 * manifest is structural truth, front matter is a redundancy copy, and
 * `derived.*` is never trusted over a recompute. So the loader takes structure
 * and metadata from `caotang.json` and body text from `docs/*.md`, and treats a
 * front-matter/manifest divergence as a notice — the file still opens, because
 * the whole point of the redundancy is that one of the two copies is always
 * readable.
 *
 * §2 validation step 4 is an *import* step, not a report step: "orphan
 * `docs/*.md` files (no tree entry) are imported as 'Recovered' documents, never
 * deleted", and codex.md §3 gives orphan `codex/*.md` the same treatment. Both
 * happen here rather than in a repair pass the user has to remember to run,
 * because a file the loader noticed and then ignored is a file that is one
 * mis-parse away from being invisible.
 *
 * A load that was fed a snapshot's bytes rather than `caotang.json` is the §5
 * recovery ladder's business; see `recovery.ts`.
 */

import type { ArtifactFs } from './artifact-fs.js';
import {
  CODEX_DIR,
  DOCS_DIR,
  FOUNTAIN_BODY_EXT,
  INK_BODY_EXT,
  bodyExtOf,
  bodyNamesOf,
  bodyStemOf,
  isBodyFileName,
  isBodyType,
} from './paths.js';
import { encodingName, guessEncoding, type EncodingGuess, type EncodingIssue } from './encoding.js';
import { parseDocumentFile } from './document-file.js';
import { parseCodexFile, codexFile } from './codex-file.js';
import type { FrontMatterError } from './document-file.js';
import { validateManifest, type ValidationReport } from './validate.js';
import { PRODUCTION_FORMAT, type AppliedMigration, type FormatContext } from './migrations.js';
import type { CodexEntry, Manifest, TreeNode } from './manifest.js';
import { backfillProjectIdentity } from './project-identity.js';
import { joinWords } from './folder-digests.js';
import { readSkills } from './skills-fs.js';
import { createProjectState, rebuildDerived, type DocumentRecord, type ProjectState } from './state.js';
import { isIdWithPrefix, newId } from '@caotang/ids';

export class ManifestUnreadableError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ManifestUnreadableError';
  }
}

export class ProjectValidationError extends Error {
  constructor(
    message: string,
    readonly report: ValidationReport,
  ) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

/**
 * A `caotang.json` this build refuses to open, rather than rebuild: it names another app, or it is in a format this build does not read
 * (project-format §3 step 2, "refused with a clear message"). The §5 recovery ladder is for a file that will not parse or will not
 * load, not for one written by a newer Caotang, which a rebuild would flatten into this build's format. The message is the writer's:
 * it names what the file is and what to do, and nothing was written.
 */
export class ProjectRefusedError extends ProjectValidationError {
  constructor(message: string, report: ValidationReport) {
    super(message, report);
    this.name = 'ProjectRefusedError';
  }
}

export interface LoadNotice {
  /** Field path, e.g. `tree[2].kind` or `top-level.foo`. */
  path: string;
  /** What the load did, for logs, tools and tests. It may name a path, an id or a spec section, so it is not shown to the writer as it is. */
  message: string;
  /**
   * The same notice as a whole sentence in the writer's words, when one can be written: it names an item by its title, never by its id,
   * its file name or a spec section. A notice without one is counted, not quoted, where an open speaks to the writer (lifecycle.ts).
   */
  say?: string;
  /**
   * Set on a notice for a field the file carries that Caotang keeps in memory and does not use (project-format §6): the field's name. The next
   * save drops every such field, so only these notices say that something will be dropped (the open notice counts them, App.tsx).
   */
  droppedField?: string;
}

export interface LoadResult {
  state: ProjectState;
  report: ValidationReport;
  notices: LoadNotice[];
  /** §2 step 4: orphan `docs/*.md` with no tree entry. Imported, never deleted. */
  orphans: string[];
  /** codex.md §3: orphan `codex/*.md` with no manifest entry. Same treatment. */
  orphanCodex: string[];
  /**
   * Every file the load found whose bytes are not UTF-8 text, each with a
   * best guess at what they are (encoding.ts). A `notices` entry says the same
   * thing in prose; this is the structured copy a caller acts on — a preview or
   * convert step reads the path and the guess rather than re-deriving them.
   * Empty when every file the load touched decoded cleanly.
   */
  encodingIssues: EncodingIssue[];
}

export interface ReadOptions {
  /**
   * Load from these bytes instead of reading `caotang.json`. The §5 ladder walks
   * `caotang.json.bak.1..3` by handing each generation to this same loader, so
   * "load a manifest" and "load the project's manifest" stay one code path with
   * one set of validation rules — a ladder that parsed snapshots by a different
   * route would be a second, quieter dialect.
   */
  manifestText?: string;
  /** Path the bytes came from, for error messages. Defaults to `caotang.json`. */
  manifestPath?: string;
  /** Timestamp for nodes created while importing orphans. Defaults to now. */
  now?: Date;
  /** The random part of an EPUB identifier this load mints, if a project lacks one. A test pins it; the app does not. */
  uuid?: () => string;
  /** The locale a missing project language is read from. Defaults to the app's. */
  locale?: string;
  /**
   * Which steps this build knows, and which version it is at — handed to
   * `validateManifest` unchanged. Defaults to the production context.
   *
   * It is one option for one reason: §2's order says the version gate and the
   * migration run *before* the field checks, so a build that can migrate is a
   * build whose validation is not the same function as a build that cannot. The
   * loader is the only place that knows which build this is, so it is the only
   * place allowed to answer.
   */
  format?: FormatContext;
}

const KNOWN_TOP_LEVEL = new Set([
  'app',
  'formatVersion',
  'project',
  'vocabulary',
  'tree',
  'derived',
  'codex',
  'filters',
  'goals',
  'recipes',
  'disabledSkills',
]);

/**
 * The node fields this build writes (project-format.md §2's field table and its
 * media note), and so the fields a load must not call unknown.
 *
 * The list is the writer's, kept by hand: `kind`, `shot` and `dialogue` are the
 * media-track fields a screenplay, a storyboard or a dialogue node carries, and
 * they are written by the serializer like any other. A list that lacked them
 * made every such project hear, on every open, that three of its own fields
 * would be "dropped on next save" — which is a lie, because the writer writes
 * them again.
 *
 * `test/read-refusal.test.ts` checks this list against the serializer rather
 * than against a copy of it, so a field added to a node later fails that test
 * until the load learns it. The set is exported for that comparison: the gate
 * has to diff the reader's own list against the writer's output, and a second
 * copy of the list in the test is exactly the drift the gate exists to catch.
 */
export const KNOWN_NODE_KEYS = new Set([
  'id',
  'parentId',
  'type',
  'title',
  'order',
  'status',
  'label',
  'keywords',
  'synopsis',
  'notes',
  'createdAt',
  'updatedAt',
  'kind',
  'shot',
  'dialogue',
  'style',
]);

/** §2 field contracts, restated for the import path (validate.ts enforces them on the manifest). */
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_CHARS = 64;
const MAX_SYNOPSIS = 2000;

/**
 * A file's bytes and their text, the text `undefined` when the bytes are not
 * UTF-8.
 *
 * The bytes are read and decoded here, strictly, rather than through `fs.read`,
 * because a backend may decode leniently. A lenient decode would hand the loader
 * replacement characters, and the next save would write those over the file's
 * original bytes. The callers below treat `undefined` as "hold this file as it is":
 * the state has no text for it, so the file is kept on disk and never rewritten.
 *
 * `bytes` rides along so a caller whose text came back `undefined` can still say
 * what the file plausibly is (`encodingIssues`) without a second read.
 */
async function readUtf8(fs: ArtifactFs, path: string): Promise<{ text: string | undefined; bytes: Uint8Array }> {
  const bytes = await fs.readBytes(path);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes };
  } catch {
    return { text: undefined, bytes };
  }
}

/**
 * Record a file whose bytes are not UTF-8 on the load's encoding report, and
 * return the entry so the notice that accompanies it can name the same guess.
 */
function recordEncodingIssue(
  issues: EncodingIssue[],
  path: string,
  kind: EncodingIssue['kind'],
  bytes: Uint8Array,
): EncodingIssue {
  const issue: EncodingIssue = { path, kind, size: bytes.length, encoding: guessEncoding(bytes) };
  issues.push(issue);
  return issue;
}

/**
 * The parenthetical a `not UTF-8` notice carries: the guess when there is one,
 * or an honest "we cannot tell" — a wrong confident name is worse than none.
 */
function encodingDetail(guess: EncodingGuess): string {
  return guess === 'unknown'
    ? 'its bytes are binary, or an encoding Caotang does not recognize'
    : `its bytes look like ${encodingName(guess)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * §6: a manifest that arrived at an older `formatVersion` is upgraded in memory,
 * and the user is told — the file on disk is still at the old version until they
 * save, so "this project was migrated" and "this file was rewritten" are two
 * different facts and the notice has to distinguish them.
 *
 * Empty for every project until format v2 exists, which is the point: this is the
 * hook that makes an in-memory migration visible instead of silent.
 */
function migrationNotices(applied: readonly AppliedMigration[]): LoadNotice[] {
  return applied.map((step) => ({
    path: 'formatVersion',
    message:
      `migrated in memory v${step.from} → v${step.to} (${step.describe}); ` +
      'the file is rewritten at the current version on the next save (§6)',
    say: 'This project was saved by an older version of Caotang. It opened as it is, and the next save writes it in the current format.',
  }));
}

/**
 * The writer's sentence for a document whose file disagrees with the project about its details. The id is not a detail the writer sees, so a
 * file that differs only there is said without naming a field.
 */
function divergenceSentence(title: string, divergences: readonly string[]): string {
  const named = divergences.filter((field) => field !== 'id');
  const which = named.length === 0 ? 'its details' : `its ${joinWords(named)}`;
  return `The file for “${title}” disagrees with the project about ${which}. The project’s details are kept.`;
}

/** §6: unknown fields are kept in memory and dropped on next save, with a notice. */
function unknownFieldNotices(parsed: Record<string, unknown>): LoadNotice[] {
  const notices: LoadNotice[] = [];
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      notices.push({
        path: `top-level.${key}`,
        message: `unknown field "${key}" kept in memory and dropped on next save`,
        droppedField: key,
      });
    }
  }
  const tree = Array.isArray(parsed.tree) ? parsed.tree : [];
  tree.forEach((node, i) => {
    if (!isRecord(node)) return;
    for (const key of Object.keys(node)) {
      if (!KNOWN_NODE_KEYS.has(key)) {
        notices.push({
          path: `tree[${i}].${key}`,
          message: `unknown node field "${key}" kept in memory and dropped on next save`,
          droppedField: key,
        });
      }
    }
  });
  return notices;
}

/**
 * The writer's words for a manifest this build refuses to open, or `null` when the failure is one the recovery ladder answers. A file that
 * names another app is refused, and so is a `formatVersion` above this build's (validate.ts steps 1 and 2). A version below 1, or one that is
 * not a whole number, is a damaged file and stays with the ladder.
 */
function refusalOf(path: string, parsed: Record<string, unknown>, firstPath: string | undefined, current: number): string | null {
  if (firstPath === 'app') {
    const named = typeof parsed.app === 'string' ? `the app “${parsed.app}”` : 'no app name';
    return `${path} names ${named}, so it is not a Caotang project, and Caotang will not open it. Nothing was written.`;
  }
  const version = parsed.formatVersion;
  if (firstPath === 'formatVersion' && typeof version === 'number' && Number.isInteger(version) && version > current) {
    return `This project was saved in format version ${version}, and this version of Caotang reads up to version ${current}, so it will not open the project. Open it in a newer Caotang. Nothing was written.`;
  }
  return null;
}

export async function readProject(fs: ArtifactFs, options: ReadOptions = {}): Promise<LoadResult> {
  const path = options.manifestPath ?? 'caotang.json';
  let text: string;
  if (options.manifestText !== undefined) {
    text = options.manifestText;
  } else {
    try {
      text = await fs.read(path);
    } catch {
      throw new ManifestUnreadableError(`no ${path} in the project folder`, path);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ManifestUnreadableError(
      `${path} is not parseable JSON: ${(cause as Error).message}`,
      path,
    );
  }

  if (!isRecord(parsed)) {
    throw new ManifestUnreadableError(`${path} is not a JSON object`, path);
  }

  const entries = await fs.listFiles(DOCS_DIR);
  const docFiles = entries.filter(isBodyFileName);

  const format = options.format ?? PRODUCTION_FORMAT;
  const report = validateManifest(parsed, {
    docFiles,
    format,
  });
  if (!report.ok) {
    const first = report.errors[0];
    const refusal = refusalOf(path, parsed, first?.path, format.current);
    if (refusal !== null) throw new ProjectRefusedError(refusal, report);
    throw new ProjectValidationError(
      `${path} failed validation at ${first?.path ?? '$'}: ${first?.message ?? 'unknown error'}`,
      report,
    );
  }

  // The state is built from the manifest that was *validated*, which is the
  // input only when no migration ran. The two diverge the moment §6's branch is
  // live, and this line is the whole reason they must not: a state assembled
  // from the raw parse is a project that was never checked. Guarded in
  // `test/migration-path.test.ts`, where a substituted registry makes the halves
  // differ — at `FORMAT_VERSION === 1` no test could tell them apart.
  const manifest = report.manifest ?? (parsed as unknown as Manifest);
  // epub-metadata.md: a project that predates the identifier and the language gets them here, once. The save that
  // follows writes them, and the notice says so, because a value the writer did not type is worth a line.
  const backfilled = backfillProjectIdentity(manifest, { uuid: options.uuid, locale: options.locale });
  const state = createProjectState(manifest, { now: options.now });
  const notices = migrationNotices(report.migrations);
  for (const field of backfilled) {
    notices.push({
      path: field,
      message:
        field === 'project.language'
          ? 'the project had no language, so it is set from the app locale; change it in the project panel'
          : 'the project had no EPUB identifier, so one was made, and the project keeps it from now on',
      say:
        field === 'project.language'
          ? 'The project had no language, so it is set from the app’s language. You can change it in the project panel.'
          : 'The project had no book identifier for EPUB, so Caotang made one, and the project keeps it from now on.',
    });
  }
  // A value the validator coerced or dropped (a citation with a bad offset, an
  // origin read as 'agent') is said on the same channel as everything else the load
  // reports. The report keeps its own copy for callers that read it there.
  for (const warning of report.warnings) notices.push({ path: warning.path, message: warning.message });
  // Run against the *effective* manifest, not the bytes we read: a §6 migration
  // is the step that reconciles a file with the current schema, so a field the
  // migration renamed is not "unknown, kept and dropped" — it was consumed. A
  // notice that described the pre-migration file would be a lie about what the
  // next save actually drops.
  notices.push(...unknownFieldNotices(manifest as unknown as Record<string, unknown>));

  const encodingIssues: EncodingIssue[] = [];
  for (const node of manifest.tree) {
    if (!isBodyType(node.type)) continue;
    // The file the folder holds for this node: its kind's own name, or the `.md` a save wrote before the kind had one
    // (the dual read). validateManifest made one of the names exist, so the fallback only names the error.
    const names = bodyNamesOf(node);
    const docName = names.find((name) => docFiles.includes(name)) ?? names[0] ?? '';
    const docPath = `${DOCS_DIR}/${docName}`;
    const docRead = await readUtf8(fs, docPath);
    const raw = docRead.text;
    if (raw === undefined) {
      // The state holds text only, and this body is not text. The node is kept with no
      // body record, the file stays on disk untouched, and the writer will not save
      // over it (write.ts). Nothing here decodes the bytes lossily, so nothing that
      // reads the project can put replacement characters into the file.
      state.declinedDocFiles.add(docName);
      const issue = recordEncodingIssue(encodingIssues, docPath, 'document', docRead.bytes);
      notices.push({
        path: docPath,
        message: `the document “${node.title}” is not UTF-8 text (${encodingDetail(issue.encoding)}), so it is held: it opens empty, its file is left as it is, and saving will not overwrite it`,
        say: `Caotang cannot read the text of “${node.title}”, so it opens empty. Its file is left as it is, and saving will not overwrite it.`,
      });
      continue;
    }
    // An Ink body is the file, whole. Ink has no front matter, and a `---` block in it would be Ink text the compiler
    // reads as story (dialogue-narrative.md §2.2), so there is nothing to parse and no divergence to report.
    if (bodyExtOf(docName) === INK_BODY_EXT) {
      state.documents.set(node.id, { id: node.id, body: raw, revision: 0 });
      continue;
    }
    let parsedDoc;
    try {
      parsedDoc = parseDocumentFile(raw);
    } catch (cause) {
      notices.push({
        path: docPath,
        message: `the front matter of “${node.title}” cannot be read (${(cause as FrontMatterError).message}); its body is kept and the manifest’s details are used`,
        say: `The details at the top of “${node.title}” could not be read. Its text is kept, and the project’s own details for it are used.`,
      });
      state.documents.set(node.id, { id: node.id, body: raw, revision: 0 });
      continue;
    }

    // The manifest wins on metadata. A divergence is worth surfacing — it means
    // somebody edited a file by hand or a write was interrupted — but it is not
    // a reason to refuse the project.
    const divergences: string[] = [];
    if (parsedDoc.frontMatter.title !== node.title) divergences.push('title');
    if (parsedDoc.frontMatter.status !== node.status) divergences.push('status');
    if (parsedDoc.frontMatter.label !== node.label) divergences.push('label');
    if (parsedDoc.frontMatter.synopsis !== node.synopsis) divergences.push('synopsis');
    if (parsedDoc.frontMatter.id !== node.id) divergences.push('id');
    if (
      parsedDoc.frontMatter.keywords.length !== node.keywords.length ||
      parsedDoc.frontMatter.keywords.some((k, i) => k !== node.keywords[i])
    ) {
      divergences.push('keywords');
    }
    if (divergences.length > 0) {
      notices.push({
        path: docPath,
        message: `the front matter of “${node.title}” differs from the manifest (${divergences.join(', ')}); the manifest’s details are kept`,
        say: divergenceSentence(node.title, divergences),
      });
    }

    const record: DocumentRecord = { id: node.id, body: parsedDoc.body, revision: 0 };
    state.documents.set(node.id, record);
  }

  // Documents first, then codex: a codex entry may be attached to a document
  // that only exists as an orphan, and dropping that attachment — or a `sources`
  // citation naming it — as "dangling" before the document is in the tree would
  // lose both real links. `dropDanglingCodexIds` is the only implementation of
  // that rule and it has to sit here, after both imports.
  placeRecoveredFolder(state);
  await importOrphanDocuments(fs, state, report.orphans, notices, options.now ?? new Date(), encodingIssues);
  const orphanCodex = await importOrphanCodex(fs, state, notices, encodingIssues);
  dropDanglingCodexIds(state, notices);
  await importSkills(fs, state, notices);

  // §2's "loader recomputes on open if absent", and it runs **here** for a
  // reason that is not tidiness: an orphan document imported three lines above
  // has a body and no count, so a rebuild placed before the import would cover
  // the manifest's own documents and silently skip every file §2 step 4 just
  // adopted. This is the first point at which `state.documents` is complete.
  rebuildDerived(state, { now: options.now });

  return { state, report, notices, orphans: report.orphans, orphanCodex, encodingIssues };
}

/**
 * Reads the project's skills into the state (skills-fs.ts). A folder the load cannot take is named in a notice and left on disk, and the
 * state does not hold it, so a save neither rewrites nor removes it.
 */
export async function importSkills(fs: ArtifactFs, state: ProjectState, notices: LoadNotice[]): Promise<void> {
  const read = await readSkills(fs);
  for (const [folder, files] of read.skills) state.skills.set(folder, files);
  for (const notice of read.notices) notices.push({ path: notice.path, message: notice.message, say: notice.say });
}

/**
 * Where a recovered document goes.
 *
 * §2 step 4 calls them "Recovered" documents and §5.2 puts rebuild output "flat
 * under a synthesized `Recovered` folder". One rule for both paths: a file that
 * no manifest entry owns has no known place in the tree, so it gets a folder of
 * its own under the manuscript, where the binder draws it. Under the root it was
 * invisible: the binder draws the manuscript and research and nothing else, so a
 * recovered scene there could be read back and never seen or deleted. The folder
 * is a normal node, so the next save persists it and the second load is an
 * ordinary load.
 */
const RECOVERED_TITLE = 'Recovered';

/** The node a `Recovered` folder sits under: the one the binder draws (ui-modules §2.1). */
const RECOVERED_PARENT = 'manuscript';

/** §2 step 4's name for an imported file, also used in the notices. */
export { RECOVERED_TITLE };

/**
 * A `Recovered` folder an earlier build left under the root, which the binder never drew. It moves under the manuscript,
 * and nothing in it changes. It runs before the orphan import, so the import finds the folder where it now is and does not
 * make a second one. Two folders can result only if both were already there, and each keeps its own documents.
 */
function placeRecoveredFolder(state: ProjectState): void {
  const stranded = state.manifest.tree.find(
    (n) => n.type === 'folder' && n.title === RECOVERED_TITLE && n.parentId === 'root',
  );
  if (stranded === undefined) return;
  const siblings = state.manifest.tree.filter((n) => n.parentId === RECOVERED_PARENT && n.id !== stranded.id);
  stranded.parentId = RECOVERED_PARENT;
  stranded.order = siblings.reduce((acc, n) => Math.max(acc, n.order), 0) + 10;
}

/**
 * The `Recovered` folder, created on demand.
 *
 * Exported because `recovery.ts` rebuilds a project from redundancy files with
 * no manifest at all, and §5.2 puts that output "flat under a synthesized
 * `Recovered` folder" — the same destination §2 step 4 uses for an orphan. One
 * function, so an orphan imported during a normal load and a document rebuilt
 * from a dead manifest land in the same place.
 */
export function recoveredFolder(state: ProjectState, now: Date): string {
  const existing = state.manifest.tree.find(
    (n) => n.type === 'folder' && n.title === RECOVERED_TITLE && n.parentId === RECOVERED_PARENT,
  );
  if (existing) return existing.id;

  const taken = new Set(state.manifest.tree.map((n) => n.id));
  const siblings = state.manifest.tree.filter((n) => n.parentId === RECOVERED_PARENT);
  const id = newId('n', { taken });
  const stamp = now.toISOString();
  const folder: TreeNode = {
    id,
    parentId: RECOVERED_PARENT,
    type: 'folder',
    title: RECOVERED_TITLE,
    order: siblings.reduce((acc, n) => Math.max(acc, n.order), 0) + 10,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
  state.manifest.tree.push(folder);
  return id;
}

/** The title of a raw Ink file the load imports: the first is "Recovered dialogue", and the rest are numbered after it. */
function inkOrphanTitle(index: number): string {
  return index === 0 ? 'Recovered dialogue' : `Recovered dialogue ${index + 1}`;
}

/**
 * §2 step 4 — orphan `docs/*.md` files are imported, never deleted.
 *
 * Two limits, both from "never deleted" rather than from caution about scale:
 *
 *   - A file whose stem is not a valid node id is left alone and reported. §1
 *     fixes document filenames as `<id>.md` with an opaque generated handle, so
 *     `notes.md` is an unknown file in the sense §1 means (loaders ignore those,
 *     never error). Minting a fresh id for it would be worse than useless: the
 *     tree would point at `docs/n_XXXX.md`, a file that does not exist.
 *   - Imported metadata is brought inside §2's field contracts before it enters
 *     the manifest. The body is never touched — it is the irreplaceable part —
 *     but a hand-made file with a 3 000-character synopsis must not be able to
 *     produce a manifest that fails to load on the next open.
 */
export async function importOrphanDocuments(
  fs: ArtifactFs,
  state: ProjectState,
  orphans: readonly string[],
  notices: LoadNotice[],
  now: Date,
  encodingIssues: EncodingIssue[] = [],
): Promise<string[]> {
  if (orphans.length === 0) return [];

  // A file named for a node that is not a document (a folder) is not an orphan
  // document, whatever the orphan computation said: importing it would give the
  // tree a second node with that id. It is declined, recorded, and kept.
  // The same rule covers a body under a name its node's kind does not use (a `.fountain` for a prose document): the
  // node already has a body, and importing a second would give it two (screenplay.md §2.1, dialogue-narrative.md §2.1).
  const takenNodes = new Map(state.manifest.tree.map((n) => [n.id, n] as const));
  const shadowed = orphans.filter((name) => takenNodes.has(bodyStemOf(name)));
  for (const name of shadowed) {
    const path = `${DOCS_DIR}/${name}`;
    state.declinedDocFiles.add(name);
    // Kept as text for an export when it is text. Bytes that are not UTF-8 have no
    // text to keep, so they stay on disk only (state.ts `declinedText`) — and are
    // named on the encoding report, the same as a declined body.
    const held = await readUtf8(fs, path);
    const text = held.text;
    if (text !== undefined) state.declinedText.set(path, text);
    const holder = takenNodes.get(bodyStemOf(name));
    const reason =
      holder !== undefined && isBodyType(holder.type)
        ? 'not imported: the node already has a body under the name its kind uses — importing this file too would give it two bodies; left untouched'
        : 'not imported: the file is named for a node that is not a document (a folder) — importing it would give the tree two nodes with one id; left untouched';
    let nonUtf8 = '';
    if (text === undefined) {
      const issue = recordEncodingIssue(encodingIssues, path, 'document', held.bytes);
      nonUtf8 = `; its text is not UTF-8 (${encodingDetail(issue.encoding)}), so it is not carried into an export`;
    }
    notices.push({ path, message: reason + nonUtf8 });
  }

  const candidates = orphans.filter((name) => !shadowed.includes(name));
  const importable = candidates.filter((name) => isIdWithPrefix('n', bodyStemOf(name)));
  const skipped = new Set(candidates.filter((name) => !importable.includes(name)));
  for (const name of skipped) {
    notices.push({
      path: `${DOCS_DIR}/${name}`,
      message: 'a file in the documents folder is not named as a document, so it is left untouched and is not part of the project',
    });
  }
  if (importable.length === 0) return [];

  const imported: string[] = [];

  const parentId = recoveredFolder(state, now);
  const order = state.manifest.tree
    .filter((n) => n.parentId === parentId)
    .reduce((acc, n) => Math.max(acc, n.order), 0);

  let inkCount = 0;
  for (const [i, name] of importable.sort().entries()) {
    const id = bodyStemOf(name);
    const path = `${DOCS_DIR}/${name}`;
    // A `.ink` file is a dialogue container and has no front matter (dialogue-narrative.md §2.2), so it is taken
    // whole. A `.fountain` file is a screenplay document and its front matter is read as a prose file's is.
    const ext = bodyExtOf(name);
    const isInk = ext === INK_BODY_EXT;
    const kind = ext === FOUNTAIN_BODY_EXT ? 'screenplay' : isInk ? 'branching' : undefined;
    // A body that is not UTF-8 is imported as a held node, the way readProject holds a
    // manuscript body: it is in the tree, it has no text in the state, and nothing
    // rewrites its file.
    const orphanRead = await readUtf8(fs, path);
    const raw = orphanRead.text;
    const stamp = now.toISOString();
    let title = id;
    let status: string | null = null;
    let label: string | null = null;
    let keywords: string[] = [];
    let synopsis = '';
    let body = raw ?? '';

    if (isInk) {
      // A raw Ink file has no front matter, so its file id would be the title the writer sees. It gets a readable name.
      title = inkOrphanTitle(inkCount);
      inkCount += 1;
      notices.push({ path, message: `a raw Ink file has no title, so it is titled "${title}"` });
    } else if (raw !== undefined) {
      try {
        const parsed = parseDocumentFile(raw);
        title = parsed.frontMatter.title;
        status = parsed.frontMatter.status;
        label = parsed.frontMatter.label;
        keywords = parsed.frontMatter.keywords;
        synopsis = parsed.frontMatter.synopsis;
        body = parsed.body;
      } catch (cause) {
        notices.push({
          path,
          message: `the front matter of a recovered document cannot be read (${(cause as FrontMatterError).message}); it is imported under its file name, and its body is kept whole`,
        });
      }
    }

    if (title.trim() === '') {
      notices.push({ path, message: 'a recovered document has no title in its front matter, so its file name is its title' });
      title = id;
    }
    if (synopsis.length > MAX_SYNOPSIS) {
      notices.push({
        path,
        message: `synopsis is ${synopsis.length} chars; trimmed to ${MAX_SYNOPSIS} to satisfy the §2 field contract`,
      });
      synopsis = synopsis.slice(0, MAX_SYNOPSIS);
    }
    if (keywords.length > MAX_KEYWORDS || keywords.some((k) => k.length > MAX_KEYWORD_CHARS)) {
      notices.push({
        path,
        message: `keywords trimmed to max ${MAX_KEYWORDS} entries of ${MAX_KEYWORD_CHARS} chars (§2)`,
      });
      keywords = keywords
        .slice(0, MAX_KEYWORDS)
        .map((k) => k.slice(0, MAX_KEYWORD_CHARS));
    }

    state.manifest.tree.push({
      id,
      parentId,
      type: isInk ? 'dialogue' : 'document',
      title,
      order: order + (i + 1) * 10,
      status,
      label,
      keywords,
      synopsis,
      notes: '',
      ...(kind === undefined ? {} : { kind }),
      createdAt: stamp,
      updatedAt: stamp,
    });
    if (raw === undefined) {
      state.declinedDocFiles.add(name);
      const issue = recordEncodingIssue(encodingIssues, path, 'document', orphanRead.bytes);
      notices.push({
        path,
        message:
          `imported as a Recovered document under the ${RECOVERED_TITLE} folder (§2 step 4), but its body is not UTF-8 text ` +
          `(${encodingDetail(issue.encoding)}): ` +
          'the document is held and opens empty; the file is left untouched on disk, and saving will not overwrite it',
        say:
          `“${title}” was in the project’s folder but not in the project, so it is added under ${RECOVERED_TITLE}. ` +
          'Caotang cannot read its text, so it opens empty, and saving will not overwrite its file.',
      });
    } else {
      state.documents.set(id, { id, body, revision: 0 });
      notices.push({
        path,
        message: `imported as a Recovered document under the ${RECOVERED_TITLE} folder (§2 step 4)`,
        say: `“${title}” was in the project’s folder but not in the project, so it is added under ${RECOVERED_TITLE}.`,
      });
    }
    imported.push(name);
  }

  return imported;
}

/**
 * codex.md §3 — "file with no manifest entry → recovered like orphan
 * `docs/*.md`": imported as a codex entry from the redundancy file's own
 * metadata, and reported in the load notice.
 *
 * Timestamps stay absent (§5.4 restores what the file carries, and the file
 * carries none). `origin` and `sources` come from the file (codex.md §10 K4), so a
 * recovered agent entry keeps its provenance. Only a file with no `origin` key —
 * one written before K4 — reads as `'manual'` (project-format §2), and that is the
 * documented default for a file that says nothing, not a guess.
 */
export async function importOrphanCodex(
  fs: ArtifactFs,
  state: ProjectState,
  notices: LoadNotice[],
  encodingIssues: EncodingIssue[] = [],
): Promise<string[]> {
  const present = (await fs.listFiles(CODEX_DIR)).filter((name) => name.endsWith('.md'));
  if (present.length === 0) return [];

  const known = new Set((state.manifest.codex ?? []).map((entry) => `${entry.id}.md`));
  const nodeIds = new Set(state.manifest.tree.map((n) => n.id));
  const orphans: string[] = [];

  for (const name of present) {
    const path = codexFile(name.slice(0, -3));
    if (known.has(name)) continue;

    const stem = name.slice(0, -3);
    if (!isIdWithPrefix('c', stem)) {
      notices.push({
        path,
        message:
          'not a codex entry file: codex.md §3 names them `<entry-id>.md`; left untouched as an unknown file',
      });
      continue;
    }

    const codexRead = await readUtf8(fs, path);
    const raw = codexRead.text;
    if (raw === undefined) {
      // Not UTF-8, so the codec cannot read it and the state cannot hold it. It is
      // declined rather than imported, and kept: the next save will not remove it,
      // for the reason the parse-failure branch below gives.
      state.declinedCodexFiles.add(name);
      const issue = recordEncodingIssue(encodingIssues, path, 'codex', codexRead.bytes);
      notices.push({
        path,
        message:
          `not UTF-8 text (${encodingDetail(issue.encoding)}), so the entry is not imported; ` +
          'the file is kept untouched and the next save will not remove it',
      });
      continue;
    }
    let parsed;
    try {
      parsed = parseCodexFile(raw);
    } catch (cause) {
      // The one file in `codex/` this load cannot read. It is recorded rather
      // than merely reported, because `writeProject`'s prune removes redundancy
      // files no manifest entry owns and an un-imported file is un-owned for
      // exactly the reason a deleted entry is — so without this the next save
      // deletes the only copy (state.ts `declinedCodexFiles`).
      state.declinedCodexFiles.add(name);
      state.declinedText.set(path, raw);
      notices.push({
        path,
        message:
          `unreadable codex front matter (${(cause as FrontMatterError).message}); entry not imported; ` +
          'the file is kept and the next save will not remove it',
      });
      continue;
    }

    // Coercions are reported for every file read, whether or not the entry is
    // then imported: the manifest path warns for an unknown policy, and this path
    // must say the same about the same value (codex.md §2).
    for (const note of parsed.coercions) notices.push({ path, message: note });

    const { frontMatter } = parsed;
    // codex.md §3: "manifest wins over redundancy files". The manifest entries —
    // and the entries this same pass has already imported — are the ones an id
    // can belong to, so the dedupe is by the id the file carries. A second file
    // carrying it is declined: kept on disk, not pruned, because it may hold text
    // the owning entry does not.
    if ((state.manifest.codex ?? []).some((entry) => entry.id === frontMatter.id)) {
      state.declinedCodexFiles.add(name);
      state.declinedText.set(path, raw);
      notices.push({
        path,
        message:
          'its front matter names a codex entry the manifest already holds; ' +
          'the manifest wins (codex.md §3) and this file is kept untouched',
      });
      continue;
    }

    const dangling = frontMatter.attachments.filter((id) => !nodeIds.has(id));
    if (dangling.length > 0) {
      notices.push({
        path,
        message: `dropped ${dangling.length} attachment id(s) that do not resolve (${dangling.join(', ')})`,
      });
    }

    const entry: CodexEntry = {
      id: frontMatter.id,
      name: frontMatter.name,
      aliases: frontMatter.aliases,
      type: frontMatter.type,
      description: parsed.description,
      includePolicy: frontMatter.includePolicy,
      caseSensitive: frontMatter.caseSensitive,
      exclude: frontMatter.exclude,
      attachments: frontMatter.attachments.filter((id) => nodeIds.has(id)),
      keywords: frontMatter.keywords,
      ...(frontMatter.visualRefs === undefined ? {} : { visualRefs: frontMatter.visualRefs }),
      // Provenance comes from the file (codex.md §10 K4). The codec has already read a
      // key that is absent as 'manual' (pre-K4 files) and coerced an unknown origin to
      // 'agent', so an agent-inferred entry is recovered as one, not as canon.
      origin: frontMatter.origin,
      sources: frontMatter.sources,
    };

    if (state.manifest.codex === undefined) state.manifest.codex = [];
    state.manifest.codex.push(entry);
    orphans.push(name);
    notices.push({
      path,
      // A file whose front matter names a different id than its own filename
      // leaves two things behind: the entry, imported under the id the front
      // matter carries, and a file no entry owns. The write path prunes that
      // file on purpose (write.ts `pruneCodexFiles`), so the load has to say so
      // — the text survives, at the entry's own id, and silence about the
      // removal is what made this worth a notice in the first place.
      message:
        entry.id === stem
          ? `imported codex entry "${entry.name}" from its redundancy file (codex.md §3)`
          : `imported codex entry "${entry.name}" as ${entry.id}, but ${path} is named for ${stem}; ` +
            `${path} is removed on the next save and the text is kept under codex/${entry.id}.md`,
      say: `The codex entry “${entry.name}” was in the project’s folder but not in the project, so it is added to the codex.`,
    });
  }

  return orphans;
}

/**
 * codex.md §2's two load-time referential rules, in one pass and in one place:
 *
 * - "`attachments` — referential integrity at load: dangling ids dropped with
 *   warning (never blocks load)"
 * - "`sources` — max 5 per entry; dangling `docId` → source dropped with warning
 *   (**same rule as `attachments`**)"
 *
 * ## Why this is here and not in `validate.ts`
 *
 * Step 4 of §2 imports orphan `docs/*.md` as "Recovered" documents, and the call
 * site below sits **after** it for that reason (see the note at the import
 * order). An attachment naming a document that exists only as a file is dangling
 * to a validator that has not run step 4 yet and resolved two steps later — so
 * dropping it in step 3 would delete exactly the link step 4 exists to preserve.
 * This is the first point at which "does this id resolve?" has an answer, and
 * the answer is false for an id that is about to be adopted.
 *
 * So the rule is stated here, once, over the whole codex: the manifest's own
 * entries and the ones §2 step 4 imported from their redundancy files, both,
 * because §2 writes the rule about the field rather than about the path that
 * filled it. Node ids are opaque and never reused, so an id that does not
 * resolve now will not resolve later: keeping it would only make the next
 * manifest carry a lie forward.
 */
function dropDanglingCodexIds(state: ProjectState, notices: LoadNotice[]): void {
  const nodeIds = new Set(state.manifest.tree.map((n) => n.id));
  for (const entry of state.manifest.codex ?? []) {
    const kept = entry.attachments.filter((id) => nodeIds.has(id));
    const dropped = entry.attachments.length - kept.length;
    if (dropped > 0) {
      entry.attachments = kept;
      notices.push({
        path: `codex.${entry.id}.attachments`,
        message: `dropped ${dropped} attachment id(s) that do not resolve (${kept.length} kept)`,
      });
    }

    // "same rule as `attachments`" — and the same question, asked of the same
    // set, in the same pass. A provenance citation naming a document that is
    // gone is a sentence pointing at a scene the reader cannot open, which is
    // worse than a missing one: it looks like evidence.
    const sources = entry.sources ?? [];
    const liveSources = sources.filter((source) => nodeIds.has(source.docId));
    const lostSources = sources.length - liveSources.length;
    if (lostSources > 0) {
      entry.sources = liveSources;
      notices.push({
        path: `codex.${entry.id}.sources`,
        message: `dropped ${lostSources} source(s) citing a docId that does not resolve (${liveSources.length} kept)`,
      });
    }
  }
}
