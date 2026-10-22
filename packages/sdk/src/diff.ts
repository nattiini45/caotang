/**
 * What saving would change in the folder, as plain text, before anything is saved.
 *
 * The state is written into an in-memory folder with the store's own `writeProject`, so the text compared is the text a save writes,
 * and each file is compared with the one the project folder holds. Only the files a save owns are looked at: `caotang.json`, the
 * documents under `docs/` and the codex files under `codex/` (project-format §3). A file on disk that no manifest names is another
 * program's, and a save leaves it alone, so it is not reported.
 */

import { CODEX_DIR, DOCS_DIR, MANIFEST_FILE, MemoryArtifactFs, writeProject, type ArtifactFs, type ProjectState } from '@caotang/store';

import { isCodexFileName, isDocumentFileName } from './folder.js';

export interface FileChange {
  /** Project-relative, POSIX. */
  readonly path: string;
  readonly kind: 'added' | 'changed' | 'removed';
  /** What the folder holds now. Absent for an added file. */
  readonly before?: string;
  /** What a save would write. Absent for a removed file. */
  readonly after?: string;
}

async function readOrUndefined(fs: ArtifactFs, path: string): Promise<string | undefined> {
  try {
    return await fs.read(path);
  } catch {
    return undefined;
  }
}

/** The project files a save owns, as text: the manifest, the documents and the codex files, by path. */
function ownedFiles(files: Readonly<Record<string, string>>): Map<string, string> {
  const owned = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const slash = path.indexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    if (path === MANIFEST_FILE || (dir === DOCS_DIR && isDocumentFileName(name)) || (dir === CODEX_DIR && isCodexFileName(name))) {
      owned.set(path, text);
    }
  }
  return owned;
}

export async function diffFolder(state: ProjectState, folder: ArtifactFs): Promise<readonly FileChange[]> {
  const memory = new MemoryArtifactFs();
  // `writeProject` stamps `modifiedAt`. Stamping the value it already holds keeps the stamp out of the comparison and out of the state.
  const stamp = new Date(state.manifest.project.modifiedAt);
  await writeProject(memory, state, { now: Number.isNaN(stamp.getTime()) ? new Date() : stamp });
  const after = ownedFiles(memory.snapshot());

  const changes: FileChange[] = [];
  for (const [path, text] of after) {
    const before = await readOrUndefined(folder, path);
    if (before === undefined) changes.push({ path, kind: 'added', after: text });
    else if (before !== text) changes.push({ path, kind: 'changed', before, after: text });
  }
  for (const [dir, owns] of [
    [DOCS_DIR, isDocumentFileName],
    [CODEX_DIR, isCodexFileName],
  ] as const) {
    for (const name of await folder.listFiles(dir)) {
      const path = `${dir}/${name}`;
      if (!owns(name) || after.has(path)) continue;
      changes.push({ path, kind: 'removed', before: (await readOrUndefined(folder, path)) ?? '' });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
