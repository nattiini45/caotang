/**
 * The §5 recovery contract — [project-format.md §5](docs/architecture/project-format.md).
 *
 * The spec is four numbered steps, and this module is those four steps and
 * nothing else:
 *
 *   1. Try `caotang.json.bak.1` → `.bak.2` → `.bak.3` (legacy `caotang.json.bak`
 *      tolerated) — first parse wins, offer the load, say which path won.
 *   2. Both dead → rebuild from front matter, with explicit user consent.
 *   3. After any recovery, write the rebuilt project as a *new* manifest and
 *      preserve the corrupt original as `caotang.json.corrupt-<timestamp>`.
 *   4. The rebuild also scans `codex/*.md` (codex.md §3).
 *
 * Two design points that the spec does not spell out and that a wrong answer
 * would quietly undo:
 *
 *   - **Recovery never writes.** {@link recoverProject} only reads and reports.
 *     §5.1 says "offer load" and §5.2 says "explicit consent", so the decision to
 *     commit belongs to the caller, in {@link commitRecovery}. A loader that
 *     silently rewrites a manifest it did not like is how a recoverable project
 *     becomes an unrecoverable one.
 *   - **The corrupt manifest is preserved *before* the new one is written, and
 *     removed rather than rotated.** `writeProject` rotates whatever is at
 *     `caotang.json` into `bak.1`; doing that with a *corrupt* manifest would push
 *     the corruption to the top of the ladder and the next open would find it
 *     first. So the bytes go to `caotang.json.corrupt-<timestamp>`, the path is
 *     cleared, and the write finds no predecessor to rotate — leaving the three
 *     good generations exactly where they were.
 */

import type { ArtifactFs } from './artifact-fs.js';
import {
  CODEX_DIR,
  DOCS_DIR,
  LEGACY_SNAPSHOT_FILE,
  MANIFEST_FILE,
  SNAPSHOT_COUNT,
  corruptManifestFile,
  isBodyFileName,
  snapshotFile,
} from './paths.js';
import { createEmptyManifest } from './create.js';
import { createProjectState, type ProjectState } from './state.js';
import { importAgentFiles, importOrphanCodex, importOrphanDocuments, importSkills, readProject, type LoadNotice } from './read.js';
import type { EncodingIssue } from './encoding.js';
import { PRODUCTION_FORMAT, type FormatContext } from './migrations.js';
import { writeProject, type WriteReport } from './write.js';

export type RecoverySource =
  | { kind: 'manifest'; path: string }
  | { kind: 'snapshot'; path: string; generation: number }
  | { kind: 'legacy-snapshot'; path: string }
  | { kind: 'rebuild' };

export interface RecoveryOffer {
  state: ProjectState;
  /** Which path the state came from — the "tell the user which path succeeded" of §5.1. */
  source: RecoverySource;
  /** True whenever the state did not come from `caotang.json` itself. */
  recovered: boolean;
  /** §5.2: a rebuild destroys structure, so it needs an explicit yes first. */
  requiresConsent: boolean;
  /** §5.2: what is unrecoverable, stated as the honest bound of one manifest. */
  loss: string[];
  notices: LoadNotice[];
  /**
   * Every file the load behind this offer found whose bytes are not UTF-8
   * text — the same report `readProject` returns (`LoadResult.encodingIssues`),
   * carried through whichever rung produced the state.
   */
  encodingIssues: EncodingIssue[];
  /** `docs/*.md` imported as Recovered documents. */
  recoveredDocuments: string[];
  /** `codex/*.md` imported as codex entries. */
  recoveredCodex: string[];
  /**
   * The unusable `caotang.json`, kept as bytes. {@link commitRecovery} writes
   * these to `caotang.json.corrupt-<timestamp>` before replacing the file, which
   * is §5.3's "the corrupt original is preserved".
   */
  corruptManifest?: { path: string; contents: string };
}

export type RecoveryResult =
  /** Loaded, or loaded from a snapshot generation — ready to open. */
  | { status: 'ok'; offer: RecoveryOffer }
  /** Only the rebuild is available; §5.2 requires the user to say yes first. */
  | { status: 'needs-consent'; offer: RecoveryOffer }
  /** No manifest generation parsed and there is no redundancy data to rebuild from. */
  | { status: 'unrecoverable'; attempts: string[] };

export interface RecoverOptions {
  /** Stamps the rebuilt project and the corrupt-preservation filename. */
  now?: Date;
  /**
   * The same context the caller opened the project with, handed to every
   * generation the §5 ladder tries. It is an option rather than a constant
   * because the ladder's own contract is that one generation is loaded by
   * exactly the rules the next one is — a snapshot judged by a different
   * migration registry than `caotang.json` is a second dialect, and §5 step 1
   * exists to prefer a *readable* backup, not one that happens to be readable by
   * a different version of the code.
   */
  format?: FormatContext;
}

/**
 * §5.2's honest bound, in the spec's own terms.
 *
 * "Folder structure and vocabulary are lost (folders have no files;
 * statuses/labels without a manifest can't validate) — the report says exactly
 * that. This is the honest bound of the single-manifest choice." A rebuild that
 * quietly presented a flat document list as if it were the project would be a
 * lie about what was kept, so these four lines are part of the return value
 * rather than something a UI is expected to compose.
 */
const REBUILD_LOSS: readonly string[] = [
  'Folder structure: folders have no files of their own, so nothing on disk records where a document used to sit. Every recovered document lands flat under a synthesized "Recovered" folder.',
  'Vocabulary: status and label terms live only in the manifest, so the rebuilt project starts with an empty vocabulary. Each document keeps its status and label values, shown as unknown until the terms are re-created.',
  'Project identity: the name and id lived in the manifest, so this is a new project with a placeholder name.',
  'Node notes, sibling order and parent links: front matter carries node-local metadata only (project-format §3), never structure.',
];

/** Read and fully load one candidate manifest. Any failure means "try the next one". */
async function tryLoad(
  fs: ArtifactFs,
  path: string,
  now: Date,
  format: FormatContext,
): Promise<{ result: Awaited<ReturnType<typeof readProject>>; text: string } | undefined> {
  let text: string;
  try {
    text = await fs.read(path);
  } catch {
    return undefined;
  }
  try {
    const result = await readProject(fs, { manifestText: text, manifestPath: path, now, format });
    return { result, text };
  } catch {
    return undefined;
  }
}

/**
 * Walk §5's ladder and report what is possible. Reads only — see the module note
 * on why committing is a separate call.
 */
export async function recoverProject(
  fs: ArtifactFs,
  options: RecoverOptions = {},
): Promise<RecoveryResult> {
  const now = options.now ?? new Date();
  const format = options.format ?? PRODUCTION_FORMAT;
  const attempts: string[] = [];

  // Step 0: the healthy path. Not a recovery, but it belongs in the same walk —
  // "the manifest was fine" is the answer the ladder must be able to return.
  const primary = await tryLoad(fs, MANIFEST_FILE, now, format);
  if (primary) {
    return {
      status: 'ok',
      offer: {
        state: primary.result.state,
        source: { kind: 'manifest', path: MANIFEST_FILE },
        recovered: false,
        requiresConsent: false,
        loss: [],
        notices: primary.result.notices,
        encodingIssues: primary.result.encodingIssues,
        recoveredDocuments: primary.result.orphans,
        recoveredCodex: primary.result.orphanCodex,
      },
    };
  }

  const corrupt = { path: MANIFEST_FILE, contents: await safeRead(fs, MANIFEST_FILE) };
  attempts.push(`${MANIFEST_FILE}: ${corrupt.contents === '' ? 'unreadable' : 'unusable'}`);

  // Step 1: the ladder, newest generation first, legacy name last.
  for (let n = 1; n <= SNAPSHOT_COUNT; n += 1) {
    const path = snapshotFile(n);
    const candidate = await tryLoad(fs, path, now, format);
    if (!candidate) {
      attempts.push(`${path}: ${(await fs.exists(path)) ? 'unusable' : 'absent'}`);
      continue;
    }
    return {
      status: 'ok',
      offer: {
        state: candidate.result.state,
        source: { kind: 'snapshot', path, generation: n },
        recovered: true,
        requiresConsent: false,
        loss: [],
        notices: [
          {
            path,
            message: `${MANIFEST_FILE} was unusable; recovered from the ${n === 1 ? 'newest' : `${n}th-newest`} snapshot generation (project-format §5.1)`,
          },
          ...candidate.result.notices,
        ],
        encodingIssues: candidate.result.encodingIssues,
        recoveredDocuments: candidate.result.orphans,
        recoveredCodex: candidate.result.orphanCodex,
        corruptManifest: corrupt,
      },
    };
  }

  const legacy = await tryLoad(fs, LEGACY_SNAPSHOT_FILE, now, format);
  if (legacy) {
    return {
      status: 'ok',
      offer: {
        state: legacy.result.state,
        source: { kind: 'legacy-snapshot', path: LEGACY_SNAPSHOT_FILE },
        recovered: true,
        requiresConsent: false,
        loss: [],
        notices: [
          {
            path: LEGACY_SNAPSHOT_FILE,
            message: `${MANIFEST_FILE} was unusable; recovered from the legacy single-generation snapshot (project-format §5.1)`,
          },
          ...legacy.result.notices,
        ],
        encodingIssues: legacy.result.encodingIssues,
        recoveredDocuments: legacy.result.orphans,
        recoveredCodex: legacy.result.orphanCodex,
        corruptManifest: corrupt,
      },
    };
  }
  attempts.push(`${LEGACY_SNAPSHOT_FILE}: ${(await fs.exists(LEGACY_SNAPSHOT_FILE)) ? 'unusable' : 'absent'}`);

  // Step 2: rebuild from redundancy files.
  const rebuild = await rebuildFromRedundancy(fs, now);
  if (!rebuild) {
    attempts.push(`${DOCS_DIR}/*.md and ${CODEX_DIR}/*.md: no redundancy data to rebuild from`);
    return { status: 'unrecoverable', attempts };
  }

  return {
    status: 'needs-consent',
    offer: {
      state: rebuild.state,
      source: { kind: 'rebuild' },
      recovered: true,
      requiresConsent: true,
      loss: [...REBUILD_LOSS],
      notices: [
        {
          path: MANIFEST_FILE,
          message: `${MANIFEST_FILE} and all three snapshot generations are unusable; offering a rebuild from redundancy files (project-format §5.2)`,
        },
        ...rebuild.notices,
      ],
      encodingIssues: rebuild.encodingIssues,
      recoveredDocuments: rebuild.documents,
      recoveredCodex: rebuild.codex,
      corruptManifest: corrupt,
    },
  };
}

async function safeRead(fs: ArtifactFs, path: string): Promise<string> {
  try {
    return await fs.read(path);
  } catch {
    return '';
  }
}

/**
 * §5.2 — "scan `docs/*.md`, parse front matter → recreate document nodes with
 * their metadata" — plus §5.4's codex pass.
 *
 * It is deliberately the same import code the ordinary load runs, with an empty
 * manifest underneath: an orphan file arriving after a torn write and a
 * document arriving after a dead manifest are the same event with a different
 * cause, and one implementation of "take this file and give it a node" cannot
 * drift from the other.
 *
 * Returns null when there is nothing to rebuild from, which is the difference
 * between "recovered a project" and "this folder was never a project".
 */
async function rebuildFromRedundancy(
  fs: ArtifactFs,
  now: Date,
): Promise<{
  state: ProjectState;
  notices: LoadNotice[];
  encodingIssues: EncodingIssue[];
  documents: string[];
  codex: string[];
} | null> {
  // The body files a folder can hold: prose `.md`, screenplay `.fountain` and dialogue `.ink` (screenplay.md §2.1,
  // dialogue-narrative.md §2.1). Each is imported by the same code the ordinary load runs, so a `.ink` file is a
  // dialogue container here too.
  const docFiles = (await fs.listFiles(DOCS_DIR)).filter(isBodyFileName);
  const codexFiles = (await fs.listFiles(CODEX_DIR)).filter((n) => n.endsWith('.md'));
  if (docFiles.length === 0 && codexFiles.length === 0) return null;

  const manifest = createEmptyManifest('Recovered project', now);
  // §5.2: "vocabulary is lost". The seeded default terms are not the author's,
  // and presenting them as recovered vocabulary would be a small lie in the
  // one report the user is guaranteed to read carefully.
  manifest.vocabulary = { statuses: [], labels: [] };

  const state = createProjectState(manifest);
  const notices: LoadNotice[] = [];
  const encodingIssues: EncodingIssue[] = [];

  const documents = await importOrphanDocuments(fs, state, [...docFiles].sort(), notices, now, encodingIssues);
  const codex = await importOrphanCodex(fs, state, notices, encodingIssues);
  await importSkills(fs, state, notices);
  await importAgentFiles(fs, state, notices, encodingIssues);

  return { state, notices, encodingIssues, documents, codex };
}

export interface RecoveryCommit {
  report: WriteReport;
  /** Where §5.3's preserved original was written, when there was one. */
  preservedAs?: string;
}

/**
 * §5.3 — "after any recovery, the rebuilt project is written as a **new**
 * manifest; the corrupt original is preserved as `caotang.json.corrupt-<ts>`".
 *
 * The order is the whole trick, and it is the reason this is a function rather
 * than a flag on {@link writeProject}: the corrupt bytes are written out and the
 * path cleared *first*, so the manifest rotation finds no predecessor. Rotating
 * a corrupt manifest would put the corruption at `bak.1` — the first rung the
 * next loader tries.
 */
export async function commitRecovery(
  fs: ArtifactFs,
  offer: RecoveryOffer,
  options: RecoverOptions = {},
): Promise<RecoveryCommit> {
  const now = options.now ?? new Date();
  let preservedAs: string | undefined;

  if (offer.corruptManifest) {
    preservedAs = corruptManifestFile(now);
    await fs.writeAtomic(preservedAs, offer.corruptManifest.contents);
    await fs.remove(offer.corruptManifest.path);
  }

  const report = await writeProject(fs, offer.state, { now });
  return { report, preservedAs };
}
