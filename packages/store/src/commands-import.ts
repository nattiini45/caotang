/**
 * The apply of `binder.importTree` (import-preview.md §5, issue #267): the shared import preview's commit, one command and so one
 * undo group. Its descriptor is the bus's (`importTreeCommands.binderImportTree`), which validates the whole batch against a
 * projection first: every node, term and picture, and the codex rows through `codex.importBatch`'s own validator.
 *
 * **Every body is round-trip checked before the first write.** The bus cannot run the store's codec, so the apply does: each body
 * is saved and parsed the way the project file will be, and a body that would not come back unchanged refuses the whole import
 * with nothing written (the `doc.import` rule, `packages/harness/src/tools/doc-import.ts`).
 *
 * **Order.** The pictures first, because they are the only step that awaits and the only one that can fail on the host (a full
 * disk): they are stored through the picture pipeline (`importPictures`, dedup by hash, GPS strip), and every body's `](import:…`
 * target becomes the picture's `../assets/` path (pictures.md D5). After the last await, synchronously: the vocabulary terms, the
 * folders and documents in reading order, then the codex pages and entries, each entry attached to the document it cites with
 * the citation moved by the rewrite.
 *
 * **One restore.** `UndoScope` holds one payload, so the apply registers one `compensate` that takes back the codex entries, the
 * codex pages, the nodes (last first), the terms, and the picture records (the files stay, as every picture undo leaves them).
 */

import { newId } from '@caotang/ids';
import {
  ApplyRefusal,
  importTreeCommands,
  type ApplyContext,
  type CommandApply,
  type CommandRegistry,
  type ImportTreeParams,
} from '@caotang/bus';

import type { ApplyClock, ProjectAssetPort } from './commands-project.js';
import { importPictures } from './commands-pictures.js';
import { parseDocumentFile, serializeDocumentFile } from './document-file.js';
import type { CodexEntry, CodexIncludePolicy, VocabularyTerm } from './manifest.js';
import { addDocument, addNode, nodeById, removeNode, type ProjectState } from './state.js';

type ProjectApply<P> = CommandApply<P, ProjectState>;

/** The colour a term the import adds starts with: a neutral grey the writer recolours in the vocabulary editor. */
export const IMPORTED_TERM_COLOR = '#8a8f98';

/** The id the round-trip check gives a body's front matter. Never written. */
const CHECK_ID = 'n_0000000000';

/** Whether the project file keeps a body exactly: the store's own save and parse, as `doc.import` checks it. */
export function keepsImportedBody(body: string, title = 'Imported'): boolean {
  try {
    const file = serializeDocumentFile({ id: CHECK_ID, title, status: null, label: null, keywords: [], synopsis: '' }, body);
    return parseDocumentFile(file).body === body;
  } catch {
    return false;
  }
}

/** A body's `import:` image targets replaced by stored paths, and a map from an old offset to the new one. */
export function rewritePictureRefs(body: string, paths: ReadonlyMap<string, string>): { body: string; map: (offset: number) => number } {
  if (paths.size === 0 || !body.includes('](import:')) return { body, map: (offset) => offset };
  const shifts: { at: number; delta: number }[] = [];
  let out = '';
  let last = 0;
  // A Markdown image or link target: `](ref)` or `](ref "title")`. Refs are tokens (`import:` + safe characters), so the match is exact.
  const pattern = /\]\((import:[A-Za-z0-9._/-]{1,120})(?=[)\s])/g;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const ref = match[1] as string;
    const path = paths.get(ref);
    if (path === undefined) continue;
    const start = match.index + 2;
    out += body.slice(last, start) + path;
    last = start + ref.length;
    shifts.push({ at: last, delta: path.length - ref.length });
  }
  out += body.slice(last);
  return {
    body: out,
    map: (offset) => {
      let moved = offset;
      for (const shift of shifts) if (shift.at <= offset) moved += shift.delta;
      return moved;
    },
  };
}

function importTreeApply(clock: ApplyClock, assets: ProjectAssetPort): ProjectApply<ImportTreeParams> {
  return async (state, params, context: ApplyContext) => {
    // 1. What the bus could not check: every body survives the store's save and parse. Nothing is written yet.
    const lost = params.nodes.flatMap((node, index) => (node.type === 'document' && !keepsImportedBody(node.body ?? '', node.title) ? [index] : []));
    if (lost.length > 0) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `${lost.length === 1 ? 'one document' : `${lost.length} documents`} (${lost
          .slice(0, 5)
          .map((index) => `"${params.nodes[index]?.title ?? index}"`)
          .join(', ')}${lost.length > 5 ? ', …' : ''}) would not come back unchanged from a save and reload, so nothing was imported`,
        target: `nodes[${lost[0]}].body`,
        correctiveHint: 'exclude those documents in the preview, or report the file so the reader can be fixed',
      });
    }

    // 2. The pictures: the only await. Their compensation is held and run inside this command's one restore.
    let takePicturesBack: (() => void) | undefined;
    const paths = new Map<string, string>();
    const pictures = params.pictures ?? [];
    if (pictures.length > 0) {
      const held: ApplyContext = {
        ...context,
        undo: { ...context.undo, compensate: (_label: string, restore: () => void) => (takePicturesBack = restore) } as ApplyContext['undo'],
        report: () => undefined,
      };
      const { stored } = await importPictures(
        state,
        assets,
        pictures.map((picture) => ({ stagingId: picture.stagingId, ...(picture.alt === undefined ? {} : { alt: picture.alt }), ...(picture.caption === undefined ? {} : { caption: picture.caption }) })),
        undefined,
        clock,
        held,
        true,
      );
      for (const [index, picture] of pictures.entries()) {
        const path = stored[index]?.path;
        if (path !== undefined) paths.set(picture.ref, `../${path}`);
      }
    }

    // Everything after this line is synchronous.
    const at = new Date(clock.now());
    const stamp = at.toISOString();

    // 3. The vocabulary terms the import adds, by name.
    const addedTerms: { kind: 'statuses' | 'labels'; term: VocabularyTerm }[] = [];
    const termId = (kind: 'statuses' | 'labels', value: string | undefined): string | null => {
      if (value === undefined) return null;
      const terms = state.manifest.vocabulary[kind];
      if (terms.some((term) => term.id === value)) return value;
      const added = addedTerms.find((entry) => entry.kind === kind && entry.term.name === value);
      return added?.term.id ?? null;
    };
    for (const kind of ['statuses', 'labels'] as const) {
      for (const name of params.vocabulary?.[kind] ?? []) {
        const terms = state.manifest.vocabulary[kind];
        const term: VocabularyTerm = { id: mintTermId(name, terms), name, color: IMPORTED_TERM_COLOR };
        terms.push(term);
        addedTerms.push({ kind, term });
      }
    }

    // 4. The nodes, in reading order: each parent is made before its children.
    const created: string[] = [];
    const ids: string[] = [];
    const maps = new Map<number, (offset: number) => number>();
    const destination = params.parentId ?? 'manuscript';
    let documents = 0;
    let folders = 0;
    for (const [index, node] of params.nodes.entries()) {
      const parentId = node.parent !== undefined ? (ids[node.parent] as string) : node.place === 'research' ? 'research' : destination;
      const status = termId('statuses', node.status);
      const label = termId('labels', node.label);
      if (node.type === 'folder') {
        const folder = addNode(state, { parentId, title: node.title, type: 'folder', now: at });
        folder.synopsis = node.synopsis ?? '';
        folder.notes = node.notes ?? '';
        folder.keywords = [...(node.keywords ?? [])];
        folder.status = status;
        folder.label = label;
        ids.push(folder.id);
        created.push(folder.id);
        folders += 1;
        continue;
      }
      const rewritten = rewritePictureRefs(node.body ?? '', paths);
      maps.set(index, rewritten.map);
      const doc = addDocument(state, {
        parentId,
        title: node.title,
        body: rewritten.body,
        type: 'document',
        synopsis: node.synopsis ?? '',
        keywords: [...(node.keywords ?? [])],
        notes: node.notes ?? '',
        ...(status === null ? {} : { status }),
        ...(label === null ? {} : { label }),
        now: at,
      });
      ids.push(doc.id);
      created.push(doc.id);
      documents += 1;
    }

    // 5. The codex pages and entries (codex.importBatch's shape), attached to the document each cites.
    const hadCodex = state.manifest.codex !== undefined;
    const pageIds: string[] = [];
    const madeEntries: CodexEntry[] = [];
    if (params.codex !== undefined) {
      for (const page of params.codex.pages ?? []) {
        pageIds.push(addDocument(state, { parentId: 'research', title: page.title, body: page.body, now: at }).id);
      }
      const codex = state.manifest.codex ?? (state.manifest.codex = []);
      const taken = new Set(codex.map((entry) => entry.id));
      for (const op of params.codex.entries) {
        const docId = op.node !== undefined ? ids[op.node] : (op.attachTo ?? pageIds[op.page ?? -1]);
        if (docId === undefined) throw new Error(`binder.importTree reached its apply with a codex row ("${op.name}") that names no document`);
        const map = op.node === undefined ? undefined : maps.get(op.node);
        const from = map === undefined ? op.cite.from : map(op.cite.from);
        const to = map === undefined ? op.cite.to : map(op.cite.to);
        const id = newId('c', { taken });
        taken.add(id);
        const entry: CodexEntry = {
          id,
          name: op.name,
          aliases: [...(op.aliases ?? [])],
          type: op.type ?? 'other',
          description: op.description ?? '',
          includePolicy: (op.includePolicy as CodexIncludePolicy | undefined) ?? 'detected',
          caseSensitive: op.caseSensitive ?? false,
          exclude: [...(op.exclude ?? [])],
          attachments: [docId],
          keywords: [...(op.keywords ?? [])],
          origin: 'import',
          sources: [{ docId, quote: op.cite.quote, from, to, extractedAt: stamp }],
          createdAt: stamp,
          updatedAt: stamp,
        };
        codex.push(entry);
        madeEntries.push(entry);
      }
      if (madeEntries.length === 0 && !hadCodex && codex.length === 0) delete state.manifest.codex;
    }

    context.undo.compensate(`undo the import of ${documents} documents and ${folders} folders`, () => {
      const gone = new Set(madeEntries.map((entry) => entry.id));
      if (gone.size > 0 && state.manifest.codex !== undefined) {
        state.manifest.codex = state.manifest.codex.filter((entry) => !gone.has(entry.id));
        // A project with no codex before the import goes back to having none, so the manifest returns to its bytes.
        if (state.manifest.codex.length === 0 && !hadCodex) delete state.manifest.codex;
      }
      for (const id of [...created, ...pageIds].reverse()) {
        if (nodeById(state, id) !== undefined) removeNode(state, id);
      }
      for (const { kind, term } of [...addedTerms].reverse()) {
        const terms = state.manifest.vocabulary[kind];
        const at = terms.findIndex((candidate) => candidate.id === term.id);
        if (at >= 0) terms.splice(at, 1);
      }
      takePicturesBack?.();
    });

    const top = created.filter((id) => {
      const parent = nodeById(state, id)?.parentId;
      return parent === destination || parent === 'research';
    });
    const parts = [
      `${documents} document${documents === 1 ? '' : 's'}`,
      `${folders} folder${folders === 1 ? '' : 's'}`,
      ...(madeEntries.length === 0 ? [] : [`${madeEntries.length} codex entr${madeEntries.length === 1 ? 'y' : 'ies'}`]),
      ...(paths.size === 0 ? [] : [`${paths.size} picture${paths.size === 1 ? '' : 's'}`]),
    ];
    context.report({
      affected: top.map((id) => ({ nodeId: id, title: nodeById(state, id)?.title ?? id })),
      summary: `imported ${parts.join(', ')}`,
    });
    return {
      parentId: destination,
      nodeIds: ids,
      documents,
      folders,
      codexEntries: madeEntries.map((entry) => entry.id),
      codexPages: pageIds,
      pictures: paths.size,
      terms: addedTerms.map(({ kind, term }) => ({ kind, id: term.id })),
    };
  };
}

/** A vocabulary id from a name, as `vocabulary.add` mints one (commands-project.ts): lower-case words joined by hyphens, unique. */
function mintTermId(name: string, terms: readonly VocabularyTerm[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'term';
  const taken = new Set(terms.map((term) => term.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: ProjectApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The registration, for the store's registry. Registered only when the host injects the asset port, as `asset.importBatch` is: the
 * apply is asynchronous (the pictures await), so a host without the port (Node, the MCP server) leaves it descriptor-only and it is
 * refused as not wired. The desktop always injects the port.
 */
export function importTreeCommandRegistrations(options: { readonly clock: ApplyClock; readonly assets?: ProjectAssetPort }): Partial<CommandRegistry> {
  if (options.assets === undefined) return {};
  return {
    'binder.importTree': { descriptor: importTreeCommands.binderImportTree, apply: narrow(importTreeApply(options.clock, options.assets)) },
  };
}
