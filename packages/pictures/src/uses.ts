/**
 * Where a picture is used — pictures.md §2.1, "uses are derived, never stored".
 *
 * A use is anything in the project that names an asset id: the project's cover, a shot's `image`, a codex entry's
 * `visualRefs`, and an inline image in a document body (`![alt](../assets/a_….png "caption")`, §3). Links (`assetLinks[]`,
 * #153) and comic panels join this list when they are built. Nothing here is written to disk; the selector reads the
 * project as it stands.
 *
 * The input is structural, so the store's `ProjectState` passes as is and this package does not depend on the store.
 */

import { ASSET_ID_PATTERN } from './ids.js';

export interface PictureProjectNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly shot?: Readonly<Record<string, unknown>> | undefined;
}

export interface PictureProjectCodexEntry {
  readonly id: string;
  readonly name: string;
  readonly visualRefs?: readonly string[] | undefined;
}

/** The parts of a project a picture can be used from. `ProjectState` satisfies it. */
export interface PictureProject {
  readonly manifest: {
    readonly project: { readonly coverAssetId?: string | null | undefined };
    readonly tree: readonly PictureProjectNode[];
    readonly codex?: readonly PictureProjectCodexEntry[] | undefined;
  };
  readonly documents?: ReadonlyMap<string, { readonly body: string }>;
}

export type PictureUse =
  | { readonly kind: 'cover' }
  | { readonly kind: 'shot'; readonly nodeId: string; readonly title: string }
  | { readonly kind: 'visualRef'; readonly entryId: string; readonly name: string }
  | { readonly kind: 'inline'; readonly docId: string; readonly title: string };

/**
 * The asset ids an inline image in a body names: a Markdown image whose target is `../assets/a_….<png|jpg|webp>` (or
 * `assets/…`, which a hand-edited body may hold). Targets outside `assets/` are not pictures of this project (§3).
 */
export function inlineAssetIds(body: string): string[] {
  const ids: string[] = [];
  // The alt text excludes `[` as well as `]`, so a failed match from one `![` never rescans the next one: a body of many
  // unclosed `![` stays linear (CodeQL js/polynomial-redos). Markdown alt text with brackets is not something we write.
  const pattern = /!\[[^[\]]*\]\(\s*<?(?:\.\.\/)?assets\/(a_[0-9A-HJKMNP-TV-Z]{10})\.(?:png|jpg|webp)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of body.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined && ASSET_ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function shotImage(node: PictureProjectNode): string | undefined {
  if (node.type !== 'shot') return undefined;
  const image = node.shot?.['image'];
  return typeof image === 'string' ? image : undefined;
}

/** Every use of one picture, in a fixed order: the cover, then shots, codex entries and documents in project order. */
export function usesOf(assetId: string, project: PictureProject): PictureUse[] {
  return allUses(project).get(assetId) ?? [];
}

/** Every use of every picture the project names, keyed by asset id. A missing file is still a use; the id is what is named. */
export function allUses(project: PictureProject): Map<string, PictureUse[]> {
  const uses = new Map<string, PictureUse[]>();
  const add = (id: string, use: PictureUse): void => {
    const list = uses.get(id);
    if (list === undefined) uses.set(id, [use]);
    else list.push(use);
  };
  const cover = project.manifest.project.coverAssetId;
  if (typeof cover === 'string' && cover !== '') add(cover, { kind: 'cover' });
  const titles = new Map<string, string>();
  for (const node of project.manifest.tree) {
    titles.set(node.id, node.title);
    const image = shotImage(node);
    if (image !== undefined) add(image, { kind: 'shot', nodeId: node.id, title: node.title });
  }
  for (const entry of project.manifest.codex ?? []) {
    for (const ref of new Set(entry.visualRefs ?? [])) add(ref, { kind: 'visualRef', entryId: entry.id, name: entry.name });
  }
  for (const [docId, doc] of project.documents ?? new Map<string, { body: string }>()) {
    for (const id of inlineAssetIds(doc.body)) add(id, { kind: 'inline', docId, title: titles.get(docId) ?? docId });
  }
  return uses;
}

/** The ids of every picture the project uses. The backfill gives each one whose file exists a record (§6.2). */
export function usedAssetIds(project: PictureProject): Set<string> {
  return new Set(allUses(project).keys());
}
