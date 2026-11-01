/**
 * `binder.importTree` — the commit of the shared import preview (issue #267, import-preview.md §5): a whole proposed binder tree,
 * its metadata, its notes, the vocabulary terms it adds, its codex rows and its pictures, as **one command and so one undo group**.
 *
 * **Why one command.** The preview is the writer's: every chapter, scene, note and codex row in it was seen before **Import**. One
 * Undo has to take all of it back, pictures and codex entries included, and the batch has to be refused whole when any part of it
 * would be. The `screenplay.import` and `codex.importBatch` precedent: one user command = one undo group. The descriptor is
 * `agentRisk: 'never'`, so the gate refuses an agent's call outright; the agent's import is `doc.import`.
 *
 * **Shape.** `nodes` is the tree flattened in reading order: each node names its parent by its index in `nodes` (an earlier
 * folder), or none for a top-level node, which lands under `parentId` (the manuscript when absent), or under research with
 * `place: 'research'` (front and back matter sent to Research). Folders may hold folders (Part → Chapter → Scene, decision 2).
 * A document's `status` and `label` name a vocabulary id the project holds or a name `vocabulary` adds. `codex.entries` are
 * `codex.importBatch` entries, with one more way to name the document they attach to: `node`, the index of an imported document.
 * `pictures` are staged bytes, each with the `ref` a body uses as an image target (`![alt](ref)`); the apply stores them through
 * the picture pipeline and writes their `../assets/` path in place of the ref (pictures.md D5).
 *
 * **Validation is whole-batch.** Every node, term, picture and codex row is checked before anything is written, against a
 * projection in which a placeholder stands for each new document, so the codex rows are checked by `codex.importBatch`'s own
 * validator. What the bus cannot see (that every body survives the store's save and parse) the store's apply checks before its
 * first write.
 */

import type { CodexImportBatchEntry, CodexImportPage, CommandDescriptor, ValidationNode, ValidationSnapshot } from './command.js';
import { codexImportBatch } from './descriptors-codex-import.js';
import { CHAPTERLESS_DOCUMENT_REFUSAL, KEYWORD_CHARS_MAX, KEYWORDS_MAX, NOTES_MAX, SYNOPSIS_MAX } from './descriptors.js';
import { ok, type CommandError, type PerOpFailure, type Result } from './result.js';
import { batchRefusal, invalid, isContainer, isRecord, limitExceeded, notFound, requireDeclaredParams, showValue } from './params.js';

/** The most nodes one import makes: a 200,000-word book split into 1,500-word scenes is about 140, so this is a ceiling only. */
export const IMPORT_TREE_NODES_MAX = 5000;
/** The text of every body of one import, summed, in characters (about three million words). */
export const IMPORT_TREE_TEXT_MAX = 20_000_000;
/** A node's title, in characters: the binder shows it. */
export const IMPORT_TREE_TITLE_MAX = 200;
/** The pictures one import stores, as `asset.importBatch` takes. */
export const IMPORT_TREE_PICTURES_MAX = 500;
/** The vocabulary terms one import adds, per kind. */
export const IMPORT_TREE_TERMS_MAX = 50;
/** A vocabulary term's name, in characters. */
export const IMPORT_TREE_TERM_CHARS_MAX = 64;
/** A picture's `ref`: a reader's token, never a path, so the rewrite of `](ref` cannot touch anything else. */
export const IMPORT_TREE_REF_PATTERN = /^import:[A-Za-z0-9._/-]{1,120}$/;

/** One node of the tree, as the preview hands it over. */
export type ImportTreeNode = {
  type: 'folder' | 'document';
  title: string;
  /** Index of an earlier folder in `nodes`; absent = a top-level node. */
  parent?: number;
  /** A top-level node only: `research` puts it under research instead of `parentId`. */
  place?: 'research';
  body?: string;
  synopsis?: string;
  keywords?: string[];
  status?: string;
  label?: string;
  notes?: string;
};

/** A codex row: a `codex.importBatch` entry that may name an imported document by its index (`node`). */
export type ImportTreeCodexEntry = Omit<CodexImportBatchEntry, 'attachTo' | 'page'> & { node?: number; attachTo?: string; page?: number };

export type ImportTreePicture = { ref: string; stagingId: string; alt?: string; caption?: string };

export type ImportTreeParams = {
  parentId?: string;
  nodes: ImportTreeNode[];
  vocabulary?: { statuses?: string[]; labels?: string[] };
  codex?: { entries: ImportTreeCodexEntry[]; pages?: CodexImportPage[] };
  pictures?: ImportTreePicture[];
};

const NODE_KEYS = ['type', 'title', 'parent', 'place', 'body', 'synopsis', 'keywords', 'status', 'label', 'notes'] as const;
const PICTURE_KEYS = ['ref', 'stagingId', 'alt', 'caption'] as const;
const CODEX_KEYS = ['entries', 'pages'] as const;
const VOCABULARY_KEYS = ['statuses', 'labels'] as const;
const DEFAULT_PARENT = 'manuscript';
/** The id a not-yet-created node carries in the projection. Never written anywhere. */
export const PENDING_IMPORT_PREFIX = 'pending:import:';

const codePoints = (text: string): number => [...text].length;

/** The folder the top-level nodes land in: the manuscript when absent; a plain folder, never the root or a media folder. */
function destinationOf(snapshot: ValidationSnapshot, raw: unknown): Result<ValidationNode, CommandError> {
  const id = raw === undefined ? DEFAULT_PARENT : raw;
  if (typeof id !== 'string' || id === '') return invalid(`params.parentId must be a node id, got ${showValue(raw)}`, 'name the folder the import goes under, or leave it out for the manuscript', 'parentId');
  const node = snapshot.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) return notFound(`no node with id "${id}" to import under`, 'use binder.read_tree to list valid ids', 'parentId');
  if (node.id === 'root') {
    return invalid('the project root is not a place for a node: the binder shows only the manuscript and research', 'import under "manuscript" or a folder inside it', 'parentId');
  }
  if (!isContainer(node)) return invalid(`parent "${node.id}" is a ${node.type} and cannot hold children`, 'import under a folder: only folders hold children', 'parentId');
  if (node.kind !== undefined) {
    return invalid(`"${node.id}" is a ${node.kind} folder, which holds its own kind of node`, 'import under the manuscript or a plain folder', 'parentId');
  }
  return ok(node);
}

/** A list of term names: non-blank, unique case-insensitively, within the limits. */
function termNames(value: unknown, field: string): Result<string[], CommandError> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return invalid(`${field} must be an array of names, got ${showValue(value)}`, undefined, field);
  if (value.length > IMPORT_TREE_TERMS_MAX) return limitExceeded(`${field} holds ${value.length} names, limit ${IMPORT_TREE_TERMS_MAX}`, 'map the rest to terms the project holds', field);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '' || codePoints(item) > IMPORT_TREE_TERM_CHARS_MAX) {
      return invalid(`${field}[${i}] must be a non-blank name of at most ${IMPORT_TREE_TERM_CHARS_MAX} characters, got ${showValue(item)}`, undefined, `${field}[${i}]`);
    }
    const key = item.trim().toLowerCase();
    if (seen.has(key)) return invalid(`${field} names "${item}" twice`, 'add each term once', `${field}[${i}]`);
    seen.add(key);
    out.push(item.trim());
  }
  return ok(out);
}

export const binderImportTree: CommandDescriptor<ImportTreeParams> = {
  mutates: 'project',
  // The writer's import, from the preview. An agent imports one document at a time through doc.import.
  agentRisk: 'never',
  // One restore for the whole import: the nodes, the terms, the codex entries and pages, and the picture records.
  undo: 'compensable',
  // The pictures go through the picture pipeline, which awaits (commands-pictures.ts); the rest is synchronous.
  asyncApply: true,
  validate: (params, snapshot): Result<ImportTreeParams, CommandError> => {
    const p = requireDeclaredParams('binder.importTree', params);
    if (!p.ok) return p;
    const destination = destinationOf(snapshot, p.value['parentId']);
    if (!destination.ok) return destination;

    const list = p.value['nodes'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.nodes must be a non-empty array of nodes, got ${showValue(list)}`, 'pass the proposed tree, one node per folder and document', 'nodes');
    }
    if (list.length > IMPORT_TREE_NODES_MAX) {
      return limitExceeded(`params.nodes has ${list.length} nodes, limit ${IMPORT_TREE_NODES_MAX}`, `import at most ${IMPORT_TREE_NODES_MAX} nodes at once`, 'nodes');
    }

    // The vocabulary terms the import adds, and the ones the project holds, by id and by name.
    const vocabulary = p.value['vocabulary'];
    if (vocabulary !== undefined && (!isRecord(vocabulary) || Object.keys(vocabulary).some((key) => !(VOCABULARY_KEYS as readonly string[]).includes(key)))) {
      return invalid('params.vocabulary must be {statuses?, labels?}, lists of the term names the import adds', undefined, 'vocabulary');
    }
    const newStatuses = termNames(isRecord(vocabulary) ? vocabulary['statuses'] : undefined, 'vocabulary.statuses');
    if (!newStatuses.ok) return newStatuses;
    const newLabels = termNames(isRecord(vocabulary) ? vocabulary['labels'] : undefined, 'vocabulary.labels');
    if (!newLabels.ok) return newLabels;
    const known = (terms: readonly { readonly id: string; readonly name?: string }[], added: readonly string[]): Set<string> =>
      new Set([...terms.map((term) => term.id), ...added]);
    const statuses = known(snapshot.manifest.vocabulary.statuses, newStatuses.value);
    const labels = known(snapshot.manifest.vocabulary.labels, newLabels.value);
    for (const [kind, added, held] of [
      ['statuses', newStatuses.value, snapshot.manifest.vocabulary.statuses],
      ['labels', newLabels.value, snapshot.manifest.vocabulary.labels],
    ] as const) {
      for (const [i, name] of added.entries()) {
        const clash = held.find((term) => term.name?.trim().toLowerCase() === name.toLowerCase());
        if (clash !== undefined) return invalid(`vocabulary.${kind}[${i}] "${name}" is already the term "${clash.id}"`, 'map the value to that term instead of adding it', `vocabulary.${kind}[${i}]`);
      }
    }

    const failures: PerOpFailure[] = [];
    const nodes: ImportTreeNode[] = [];
    let text = 0;
    for (const [index, raw] of list.entries()) {
      const target = `nodes[${index}]`;
      const fail = (message: string, field?: string, hint?: string): void => {
        failures.push({ target: field === undefined ? target : `${target}.${field}`, code: 'invalid-params', message: `${target}: ${message}`, ...(hint === undefined ? {} : { correctiveHint: hint }) });
      };
      if (!isRecord(raw)) {
        fail(`must be an object, got ${showValue(raw)}`);
        nodes.push({ type: 'folder', title: '' });
        continue;
      }
      const extra = Object.keys(raw).find((key) => !(NODE_KEYS as readonly string[]).includes(key));
      if (extra !== undefined) fail(`"${extra}" is not a field of a node`, extra, `a node carries only: ${NODE_KEYS.join(', ')}`);
      const type = raw['type'];
      if (type !== 'folder' && type !== 'document') fail(`type must be "folder" or "document", got ${showValue(type)}`, 'type');
      const title = raw['title'];
      if (typeof title !== 'string' || title.trim() === '') fail('title must be a non-blank string', 'title', 'give every chapter and scene a title');
      else if (codePoints(title) > IMPORT_TREE_TITLE_MAX) fail(`title is ${codePoints(title)} characters, limit ${IMPORT_TREE_TITLE_MAX}`, 'title');

      // The parent: an earlier folder of this import, or the destination (or research) for a top-level node.
      const parent = raw['parent'];
      const place = raw['place'];
      let parentNode: ImportTreeNode | 'destination' | 'research' | undefined;
      if (parent !== undefined) {
        if (typeof parent !== 'number' || !Number.isInteger(parent) || parent < 0 || parent >= index) fail(`parent must be the index of an earlier node, got ${showValue(parent)}`, 'parent');
        else if (nodes[parent]?.type !== 'folder') fail(`parent ${parent} is not a folder, and only folders hold children`, 'parent');
        else parentNode = nodes[parent];
        if (place !== undefined) fail('place is for a top-level node; this one names a parent', 'place');
      } else if (place !== undefined) {
        if (place !== 'research') fail(`place must be "research", got ${showValue(place)}`, 'place');
        else parentNode = 'research';
      } else {
        parentNode = 'destination';
      }
      if (type === 'document' && parentNode === 'destination' && destination.value.id === DEFAULT_PARENT) {
        fail(CHAPTERLESS_DOCUMENT_REFUSAL, undefined, 'put the document inside a chapter folder of the import');
      }

      const body = raw['body'];
      if (body !== undefined) {
        if (type !== 'document') fail('a folder holds no body', 'body');
        else if (typeof body !== 'string') fail(`body must be a string, got ${showValue(body)}`, 'body');
        else text += body.length;
      }
      const synopsis = raw['synopsis'];
      if (synopsis !== undefined && (typeof synopsis !== 'string' || codePoints(synopsis) > SYNOPSIS_MAX)) fail(`synopsis must be a string of at most ${SYNOPSIS_MAX} characters`, 'synopsis');
      const notes = raw['notes'];
      if (notes !== undefined && (typeof notes !== 'string' || codePoints(notes) > NOTES_MAX)) fail(`notes must be a string of at most ${NOTES_MAX} characters`, 'notes', 'keep the rest in a Research document');
      const keywords = raw['keywords'];
      if (keywords !== undefined) {
        if (!Array.isArray(keywords) || keywords.length > KEYWORDS_MAX) fail(`keywords must be at most ${KEYWORDS_MAX} strings`, 'keywords');
        else if (keywords.some((keyword) => typeof keyword !== 'string' || keyword.trim() === '' || codePoints(keyword) > KEYWORD_CHARS_MAX)) {
          fail(`each keyword must be non-blank and at most ${KEYWORD_CHARS_MAX} characters`, 'keywords');
        }
      }
      const status = raw['status'];
      if (status !== undefined && !(typeof status === 'string' && statuses.has(status))) fail(`status ${showValue(status)} is neither a status of the project nor one this import adds`, 'status', 'map it to a status, add it, or leave it out');
      const label = raw['label'];
      if (label !== undefined && !(typeof label === 'string' && labels.has(label))) fail(`label ${showValue(label)} is neither a label of the project nor one this import adds`, 'label', 'map it to a label, add it, or leave it out');

      nodes.push({
        type: type === 'document' ? 'document' : 'folder',
        title: typeof title === 'string' ? title : '',
        ...(typeof parent === 'number' ? { parent } : {}),
        ...(place === 'research' ? { place } : {}),
        ...(typeof body === 'string' ? { body } : {}),
        ...(typeof synopsis === 'string' ? { synopsis } : {}),
        ...(Array.isArray(keywords) ? { keywords: keywords as string[] } : {}),
        ...(typeof status === 'string' ? { status } : {}),
        ...(typeof label === 'string' ? { label } : {}),
        ...(typeof notes === 'string' ? { notes } : {}),
      });
    }
    if (text > IMPORT_TREE_TEXT_MAX) {
      return limitExceeded(`the bodies hold ${text} characters, limit ${IMPORT_TREE_TEXT_MAX}`, 'import the book in parts', 'nodes');
    }

    // The pictures: staged bytes, each with a ref the bodies use. A ref no body uses is still stored (the reader listed it).
    const rawPictures = p.value['pictures'];
    const pictures: ImportTreePicture[] = [];
    if (rawPictures !== undefined) {
      if (!Array.isArray(rawPictures)) return invalid(`params.pictures must be an array, got ${showValue(rawPictures)}`, undefined, 'pictures');
      if (rawPictures.length > IMPORT_TREE_PICTURES_MAX) {
        return limitExceeded(`params.pictures has ${rawPictures.length} pictures, limit ${IMPORT_TREE_PICTURES_MAX}`, 'turn the pictures option off, or import the book in parts', 'pictures');
      }
      const refs = new Set<string>();
      const staged = new Set<string>();
      for (const [index, raw] of rawPictures.entries()) {
        const target = `pictures[${index}]`;
        if (!isRecord(raw) || Object.keys(raw).some((key) => !(PICTURE_KEYS as readonly string[]).includes(key))) {
          failures.push({ target, code: 'invalid-params', message: `${target}: must be {ref, stagingId, alt?, caption?}` });
          continue;
        }
        const { ref, stagingId, alt, caption } = raw;
        if (typeof ref !== 'string' || !IMPORT_TREE_REF_PATTERN.test(ref) || refs.has(ref)) {
          failures.push({ target: `${target}.ref`, code: 'invalid-params', message: `${target}: ref ${showValue(ref)} must be a unique "import:" token` });
          continue;
        }
        if (typeof stagingId !== 'string' || stagingId === '' || stagingId.length > 64 || staged.has(stagingId)) {
          failures.push({ target: `${target}.stagingId`, code: 'invalid-params', message: `${target}: stagingId must name one staged picture, once` });
          continue;
        }
        if ((alt !== undefined && typeof alt !== 'string') || (caption !== undefined && typeof caption !== 'string')) {
          failures.push({ target, code: 'invalid-params', message: `${target}: alt and caption must be strings` });
          continue;
        }
        refs.add(ref);
        staged.add(stagingId);
        pictures.push({ ref, stagingId, ...(alt === undefined ? {} : { alt }), ...(caption === undefined ? {} : { caption }) });
      }
    }

    // The codex rows, checked by codex.importBatch's own validator against a projection that holds the new documents.
    const rawCodex = p.value['codex'];
    let codex: ImportTreeParams['codex'];
    if (rawCodex !== undefined && failures.length === 0) {
      if (!isRecord(rawCodex) || Object.keys(rawCodex).some((key) => !(CODEX_KEYS as readonly string[]).includes(key)) || !Array.isArray(rawCodex['entries'])) {
        return invalid('params.codex must be {entries, pages?}, as codex.importBatch takes them', undefined, 'codex');
      }
      const entries = rawCodex['entries'] as unknown[];
      const mapped: unknown[] = [];
      for (const [index, entry] of entries.entries()) {
        if (!isRecord(entry) || entry['node'] === undefined) {
          mapped.push(entry);
          continue;
        }
        const at = entry['node'];
        if (typeof at !== 'number' || !Number.isInteger(at) || nodes[at]?.type !== 'document' || entry['attachTo'] !== undefined || entry['page'] !== undefined) {
          failures.push({ target: `codex.entries[${index}].node`, code: 'invalid-params', message: `codex.entries[${index}]: node must be the index of an imported document, and the only document the entry names` });
          mapped.push(entry);
          continue;
        }
        const { node: _node, ...rest } = entry;
        mapped.push({ ...rest, attachTo: `${PENDING_IMPORT_PREFIX}${at}` });
      }
      if (failures.length === 0) {
        const projected = projectedSnapshot(snapshot, destination.value.id, nodes);
        const checked = codexImportBatch.validate({ entries: mapped, ...(rawCodex['pages'] === undefined ? {} : { pages: rawCodex['pages'] }) }, projected);
        if (!checked.ok) {
          return { ok: false, error: { ...checked.error, message: `codex: ${checked.error.message}`, target: checked.error.target === undefined ? 'codex' : `codex.${checked.error.target}` } };
        }
        codex = {
          entries: checked.value.entries.map((entry) => {
            const { attachTo, ...rest } = entry;
            if (attachTo?.startsWith(PENDING_IMPORT_PREFIX) === true) return { ...rest, node: Number(attachTo.slice(PENDING_IMPORT_PREFIX.length)) };
            return attachTo === undefined ? rest : { ...rest, attachTo };
          }),
          ...(checked.value.pages === undefined ? {} : { pages: checked.value.pages }),
        };
      }
    }

    if (failures.length > 0) return batchRefusal(failures, 'fix every listed node in the preview and import again — nothing was written');
    const vocabularyOut = newStatuses.value.length + newLabels.value.length === 0
      ? undefined
      : { ...(newStatuses.value.length === 0 ? {} : { statuses: newStatuses.value }), ...(newLabels.value.length === 0 ? {} : { labels: newLabels.value }) };
    return ok({
      parentId: destination.value.id,
      nodes,
      ...(vocabularyOut === undefined ? {} : { vocabulary: vocabularyOut }),
      ...(codex === undefined ? {} : { codex }),
      ...(pictures.length === 0 ? {} : { pictures }),
    });
  },
};

/** The snapshot with a placeholder node and body for each imported node, so the codex rows can name and cite them. */
function projectedSnapshot(snapshot: ValidationSnapshot, destinationId: string, nodes: readonly ImportTreeNode[]): ValidationSnapshot {
  const tree: ValidationNode[] = [...snapshot.manifest.tree];
  const documents = new Map(snapshot.documents);
  for (const [index, node] of nodes.entries()) {
    const id = `${PENDING_IMPORT_PREFIX}${index}`;
    const parentId = node.parent !== undefined ? `${PENDING_IMPORT_PREFIX}${node.parent}` : node.place === 'research' ? 'research' : destinationId;
    tree.push({ id, parentId, type: node.type, title: node.title, status: null, label: null, keywords: [], synopsis: '', notes: '' });
    if (node.type === 'document') documents.set(id, { body: node.body ?? '', revision: 0 });
  }
  return { ...snapshot, manifest: { ...snapshot.manifest, tree }, documents };
}
