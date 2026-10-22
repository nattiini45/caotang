/**
 * Artifact path constants — [project-format.md §1](docs/architecture/project-format.md).
 *
 * These live apart from the write path because more than one module needs them
 * and they must not depend on each other to do it: the write path builds these
 * paths, the read path and the §5 recovery ladder follow them, and the codex
 * redundancy codec names one of them. A constant that has to be imported from
 * the module that *uses* it is a dependency cycle waiting to bite at module
 * init, so it gets its own file.
 *
 * Every path is project-root-relative and POSIX-separated — the
 * {@link ArtifactFs} port's contract, not a platform detail.
 */

export const MANIFEST_FILE = 'caotang.json';
export const DOCS_DIR = 'docs';
export const CODEX_DIR = 'codex';
export const EXPORTS_DIR = 'exports';
export const GITIGNORE_FILE = '.gitignore';
export const SESSIONS_FILE = 'sessions.jsonl';

/**
 * Where a project's skills live: one Agent Skills folder per skill, `.agents/skills/<name>/SKILL.md` and the files beside it
 * (project-format.md §1, extensibility.md §10). The neutral root other agents read; `.claude/skills` is not read.
 */
export const SKILLS_DIR = '.agents/skills';

/** The project-relative path of one file of one skill: `.agents/skills/<folder>/<path>`. */
export function skillFilePath(folder: string, path: string): string {
  return `${SKILLS_DIR}/${folder}/${path}`;
}

/**
 * §5.1 tolerates this pre-ladder name for hand-made artifacts: "legacy
 * `caotang.json.bak` tolerated". It is tried *last*, after the whole N=3 ladder,
 * because the ladder generations are the ones a Caotang write path produced and
 * therefore strictly better informed than whatever a person made.
 */
export const LEGACY_SNAPSHOT_FILE = `${MANIFEST_FILE}.bak`;

/** Rolling snapshot depth (project-format §9 A3): recovery depth should be automatic and boring. */
export const SNAPSHOT_COUNT = 3;

export function snapshotFile(n: number): string {
  return `${MANIFEST_FILE}.bak.${n}`;
}

export function docFile(id: string): string {
  return `${DOCS_DIR}/${id}.md`;
}

/**
 * The body file extensions, by the kind of body a node holds (screenplay.md §2.1, dialogue-narrative.md §2.1,
 * project-format.md §3's media-track note). Written without a dot here; the media engines write the dotted form
 * (`INK_BODY_EXTENSION`, `FOUNTAIN_EXTENSION`), and a parity test in the exporter pins the two spellings together.
 * This package cannot import those engines: they depend on it.
 */
export const PROSE_BODY_EXT = 'md';
export const FOUNTAIN_BODY_EXT = 'fountain';
export const INK_BODY_EXT = 'ink';

/** The body extensions the loader reads and the recovery scan imports, in the order a name is tried. */
export const BODY_EXTENSIONS = [PROSE_BODY_EXT, FOUNTAIN_BODY_EXT, INK_BODY_EXT] as const;

/** A tree node that holds a body: a document (prose or screenplay) or a dialogue container. */
export function isBodyType(type: string): boolean {
  return type === 'document' || type === 'dialogue';
}

/**
 * The extension a body node's file uses (screenplay.md §2.1, dialogue-narrative.md §2.1): `.fountain` for a
 * screenplay document, `.ink` for a dialogue container, `.md` for everything else.
 */
export function bodyExtensionOf(node: { readonly type: string; readonly kind?: string }): string {
  if (node.type === 'dialogue') return INK_BODY_EXT;
  if (node.type === 'document' && node.kind === 'screenplay') return FOUNTAIN_BODY_EXT;
  return PROSE_BODY_EXT;
}

/** The basename of a body node's file under `docs/`, for its kind. */
export function bodyFileName(node: { readonly id: string; readonly type: string; readonly kind?: string }): string {
  return `${node.id}.${bodyExtensionOf(node)}`;
}

/** The project-relative path of a body node's file, for its kind. */
export function bodyFile(node: { readonly id: string; readonly type: string; readonly kind?: string }): string {
  return `${DOCS_DIR}/${bodyFileName(node)}`;
}

/**
 * The names a body node's file may carry, in the order a load tries them: its kind's own file first, then the
 * `.md` a save wrote before the kind had one of its own (dual read, project-format.md §3). One name for a prose
 * document.
 */
export function bodyNamesOf(node: { readonly id: string; readonly type: string; readonly kind?: string }): string[] {
  const own = bodyFileName(node);
  const legacy = `${node.id}.${PROSE_BODY_EXT}`;
  return own === legacy ? [own] : [own, legacy];
}

/**
 * The names a body node carries beside its kind's own file, which are the `.md` a save wrote before the kind had one of its
 * own (project-format.md §3). Empty for a prose document, whose one name is its own. A save removes these once it has written
 * the kind's file: the load reads the kind's file first, so the older name is a second copy that nothing reads.
 */
export function legacyBodyNamesOf(node: { readonly id: string; readonly type: string; readonly kind?: string }): string[] {
  const own = bodyFileName(node);
  return bodyNamesOf(node).filter((name) => name !== own);
}

/** Whether a basename under `docs/` is a body file: one of the body extensions, and nothing else. */
export function isBodyFileName(name: string): boolean {
  return BODY_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));
}

/** The node id a body file is named for: its basename without the extension. */
export function bodyStemOf(name: string): string {
  return name.slice(0, name.lastIndexOf('.'));
}

/** The extension of a body file's basename, without its dot. */
export function bodyExtOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * §5.3: the corrupt original is preserved as `caotang.json.corrupt-<timestamp>`.
 *
 * The stamp is a filename, not a display string, so it is the ISO-8601 instant
 * with the characters that are awkward in a path replaced: `2026-09-29T02-14-33-123Z`.
 * Colons are legal in an NTFS name and a disaster in a zip entry, a shell
 * pipeline and a synced folder, and the spec only asks for "a timestamp".
 */
export function corruptManifestFile(when: Date): string {
  return `${MANIFEST_FILE}.corrupt-${when.toISOString().replace(/[:.]/g, '-')}`;
}
