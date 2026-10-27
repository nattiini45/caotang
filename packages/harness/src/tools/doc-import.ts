/**
 * `doc.import` — the extension beyond agent-harness.md §3's frozen fourteen,
 * write-confirm, one undo group. It exists so existing writing can move into Caotang
 * without a model paraphrasing it. Over MCP the write-confirm is the host's own
 * confirmation dialog (extensibility §9, elicitation), so an external caller can
 * run it once the project allows writes.
 *
 * **The body must survive a save and a reload.** A body the project file would not
 * give back unchanged is refused before anything is created, and the read-back checks
 * the round trip too. The codec's rule is not restated here: the check runs the
 * store's own save and parse, so when the codec learned to keep trailing newlines
 * (the 2026-10-08 store debt), this gate learned it with no edit.
 *
 * **What it dispatches, in order:** `binder.create` (a document under the parent),
 * then `doc.write` (the body, exactly as given), then `binder.setSynopsis` and
 * `binder.setMeta` for whichever of synopsis, keywords, status and label were sent.
 * All four sit in the caller's undo group, so one undo removes the whole import.
 *
 * **All four are validated before the first runs.** The three after the create
 * name the document the create will mint, and that id does not exist until the
 * create has run. So the batch is validated against a projection in which a
 * placeholder stands for the new document, using the bus's own validators. A
 * placeholder is refused nowhere, because the validators only look ids up in the
 * snapshot they are handed. Anything the bus would refuse is refused before any
 * effect, and the post-create dispatch can then only fail for a reason the
 * pre-check did not see.
 *
 * **Verification** (agent-harness §7): after the batch, the new node is read back
 * and compared with what was asked for. A mismatch is reported as `postcondition`
 * with the undo group named. It is not undone automatically, because the bus's
 * rule is that a failed check is reported, and the user reverses it.
 *
 * **Not checked: duplicate titles.** Nothing stops a second import of the same
 * title under the same parent. That is a decision for the project owner (a retry
 * across turns creates a second document), and it is listed as an open decision in the report that landed this package.
 */

import { ok, type CommandError, type Result, type ValidationSnapshot } from '@caotang/bus';
import {
  countBody,
  getBody,
  parseDocumentFile,
  serializeDocumentFile,
  type DocumentFrontMatter,
  type ProjectState,
  type TreeNode,
} from '@caotang/store';

import { importScanSentence, scanImport } from '../agent/untrusted.js';
import { failure, invalidParams, refusal } from '../errors.js';
import { CONTAINER, resolveNode } from '../resolve.js';
import { param, type ObjectSpec } from '../schema.js';
import type { ActivityAffected, CallParams, CommandDone, PreparedCall, PreparedCommand, PrepareContext, ToolValue } from '../types.js';
import { batchRefusal, checkCommand, createdNodeId, projectedSnapshot } from './common.js';

/** Synopsis limit, project-format §2. The bus enforces it on `binder.setSynopsis`; this is the same number. */
const SYNOPSIS_MAX = 2000;
/** Keyword limits, project-format §2 (32 keywords of up to 64 characters). */
const KEYWORDS_MAX = 32;
const KEYWORD_CHARS_MAX = 64;
/** The id a not-yet-created document carries in the projection. Never written anywhere. */
const PENDING_DOCUMENT = 'pending:doc.import';

export const docImportParams: ObjectSpec = param.object(
  'The document to import, stored exactly as given, with its metadata.',
  {
    parent: param.string('The chapter or folder that holds the document: a title or an id.', { nonBlank: true }),
    title: param.string('The document title.', { nonBlank: true }),
    body: param.string('The body, as markdown. Stored exactly as given: no paraphrase, no trimming.'),
    synopsis: param.string(`A synopsis, at most ${SYNOPSIS_MAX} characters.`, { maxLength: SYNOPSIS_MAX }),
    keywords: param.list(
      `Keywords, at most ${KEYWORDS_MAX}, each at most ${KEYWORD_CHARS_MAX} characters.`,
      param.string('One keyword.', { nonBlank: true, maxLength: KEYWORD_CHARS_MAX }),
      { maxItems: KEYWORDS_MAX },
    ),
    status: param.string('A status id from the project vocabulary.', { nonBlank: true }),
    label: param.string('A label id from the project vocabulary.', { nonBlank: true }),
  },
  ['parent', 'title', 'body'],
);

export function prepareDocImport(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const parentRef = typeof params['parent'] === 'string' ? params['parent'] : '';
  const parent = resolveNode(state, parentRef, CONTAINER, 'folder', 'params.parent');
  if (!parent.ok) return failure(parent.error) as Result<PreparedCall, CommandError>;

  const title = String(params['title']);
  const body = String(params['body']);
  const synopsis = typeof params['synopsis'] === 'string' ? params['synopsis'] : undefined;
  const keywords = Array.isArray(params['keywords']) ? [...(params['keywords'] as string[])] : undefined;
  const status = typeof params['status'] === 'string' ? params['status'] : undefined;
  const label = typeof params['label'] === 'string' ? params['label'] : undefined;

  // Refused before anything is projected or created: a body the project file would not keep is not imported.
  const frontMatter: DocumentFrontMatter = {
    id: PENDING_DOCUMENT,
    title,
    status: status ?? null,
    label: label ?? null,
    keywords: keywords ?? [],
    synopsis: synopsis ?? '',
  };
  if (!keepsBody(body, frontMatter)) {
    return failure(
      invalidParams(
        'params.body would not come back unchanged from a save and reload, so the project file would not keep it as sent',
        'send the body as markdown text the project file can hold; the read-back compares it character for character',
        'params.body',
      ),
    ) as Result<PreparedCall, CommandError>;
  }

  // The projection: the tree with a placeholder node, and a placeholder body.
  const placeholder: TreeNode = {
    id: PENDING_DOCUMENT,
    parentId: parent.value.id,
    type: 'document',
    title,
    order: Number.MAX_SAFE_INTEGER,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
  };
  const documents = new Map(state.documents);
  documents.set(PENDING_DOCUMENT, { id: PENDING_DOCUMENT, body: '', revision: 0 });
  const projected = projectedSnapshot(state, [...state.manifest.tree, placeholder], documents);
  const before = projectedSnapshot(state, state.manifest.tree);

  const failures: { target: string; error: CommandError }[] = [];
  const check = (
    name: 'binder.create' | 'doc.write' | 'binder.setSynopsis' | 'binder.setMeta',
    command: Record<string, unknown>,
    snapshot: ValidationSnapshot,
    target: string,
  ): void => {
    const checked = checkCommand(context, name, command, snapshot);
    if (!checked.ok) failures.push({ target, error: checked.error });
  };

  const createParams = { parentId: parent.value.id, type: 'document', title };
  check('binder.create', createParams, before, 'params.title');
  check('doc.write', { docId: PENDING_DOCUMENT, body, expectedRevision: 0 }, projected, 'params.body');

  const patch: Record<string, unknown> = {};
  if (status !== undefined) patch['status'] = status;
  if (label !== undefined) patch['label'] = label;
  if (keywords !== undefined && keywords.length > 0) patch['keywords_add'] = keywords;

  if (synopsis !== undefined) check('binder.setSynopsis', { nodeId: PENDING_DOCUMENT, synopsis }, projected, 'params.synopsis');
  if (Object.keys(patch).length > 0) check('binder.setMeta', { nodeId: PENDING_DOCUMENT, patch }, projected, 'params');

  if (failures.length > 0) {
    return failure(
      batchRefusal(failures, failures.length, 'fix the listed field and resend the import — nothing was written'),
    ) as Result<PreparedCall, CommandError>;
  }

  const commands: PreparedCommand[] = [
    { name: 'binder.create', params: createParams },
    { name: 'doc.write', params: (done: readonly CommandDone[]) => ({ docId: createdNodeId(done) ?? '', body, expectedRevision: 0 }) },
  ];
  if (synopsis !== undefined) {
    commands.push({ name: 'binder.setSynopsis', params: (done: readonly CommandDone[]) => ({ nodeId: createdNodeId(done) ?? '', synopsis }) });
  }
  if (Object.keys(patch).length > 0) {
    commands.push({ name: 'binder.setMeta', params: (done: readonly CommandDone[]) => ({ nodeId: createdNodeId(done) ?? '', patch }) });
  }

  const expected = { title, parentId: parent.value.id, body, synopsis, keywords, status, label };
  // The text is stored as given; the scan only tells the writer, on the card and in the result, what in it reads like instructions to a model (issue #54).
  const scan = scanImport([
    { where: 'title', text: title },
    { where: 'body', text: body },
    ...(synopsis === undefined ? [] : [{ where: 'synopsis', text: synopsis }]),
    ...(keywords ?? []).map((keyword, index) => ({ where: `keywords[${index}]`, text: keyword })),
  ]);
  return ok({
    commands,
    preview: { parent: parent.value.title, title, words: wordCount(body), synopsisLength: synopsis?.length ?? 0, ...(scan.total === 0 ? {} : { scan }) },
    finish: (done: readonly CommandDone[]) => withScan(verifyImport(state, done, expected, parent.value.title), title, scan),
  });
}

/** The import's result with the scan's findings added to its data, its notes and its summary, when there are any. */
function withScan(result: Result<ToolValue, CommandError>, title: string, scan: ReturnType<typeof scanImport>): Result<ToolValue, CommandError> {
  const sentence = importScanSentence(`“${title}”`, scan);
  if (!result.ok || sentence === undefined) return result;
  return ok({
    ...result.value,
    data: { ...result.value.data, scan },
    summary: `${result.value.summary}; ${scan.total} ${scan.total === 1 ? 'passage reads' : 'passages read'} like instructions to a model`,
    notes: [...(result.value.notes ?? []), sentence],
  });
}

/** The store's own count, so an import reports the number the rest of the app reports. */
function wordCount(body: string): number {
  return countBody(body).words;
}

/**
 * Whether a body comes back from a save and a reload exactly as it went in. It runs
 * the store's own serialise and parse, so the answer is the codec's and not a copy of
 * its rule. The front matter is passed through as the save would pass it.
 */
function keepsBody(body: string, frontMatter: DocumentFrontMatter): boolean {
  return parseDocumentFile(serializeDocumentFile(frontMatter, body)).body === body;
}

/** The front matter a saved document carries, built the way the store builds it on save. */
function frontMatterOf(node: TreeNode): DocumentFrontMatter {
  return { id: node.id, title: node.title, status: node.status, label: node.label, keywords: node.keywords, synopsis: node.synopsis };
}

interface Expected {
  readonly title: string;
  readonly parentId: string;
  readonly body: string;
  readonly synopsis: string | undefined;
  readonly keywords: readonly string[] | undefined;
  readonly status: string | undefined;
  readonly label: string | undefined;
}

function verifyImport(
  state: ProjectState,
  done: readonly CommandDone[],
  expected: Expected,
  parentTitle: string,
): Result<ToolValue, CommandError> {
  const id = createdNodeId(done);
  const undoGroupId = done[0]?.outcome.undoGroupId;
  const node = id === undefined ? undefined : state.manifest.tree.find((candidate) => candidate.id === id);
  const found = node === undefined || id === undefined ? [] : mismatches(state, node, expected, id);
  if (node === undefined || found.length > 0) {
    return failure(
      refusal(
        'postcondition',
        `the import ran, but the new document does not match what was asked for: ${found.length > 0 ? found.join('; ') : 'the document was not found'}. The undo group is registered and intact, so this is reversible.`,
        {
          correctiveHint: 'undo the import and report the mismatch to the user; do not retry the import blindly',
          details: {
            ...(undoGroupId === undefined ? {} : { undoGroupId }),
            failures: found.map((message) => ({ target: 'doc.import', code: 'postcondition', message })),
          },
        },
      ),
    ) as Result<ToolValue, CommandError>;
  }
  return ok({
    data: {
      doc: { id: node.id, title: node.title },
      parent: { title: parentTitle },
      words: wordCount(expected.body),
      characters: getBody(state, node.id).length,
    },
    summary: `imported "${node.title}" under "${parentTitle}" (${wordCount(expected.body)} words)`,
    affected: distinctAffected(done.flatMap((entry) => [...entry.outcome.affected])),
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  });
}

/**
 * Each node a change touched, once. The import's steps each report the nodes they touched, and the new document is in more
 * than one of those lists, so the result lists it once, at its first place (the harness's result contract).
 */
function distinctAffected(entries: readonly ActivityAffected[]): ActivityAffected[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.nodeId)) return false;
    seen.add(entry.nodeId);
    return true;
  });
}

/** What the read-back does not match. An empty list is a clean import. */
function mismatches(state: ProjectState, node: TreeNode, expected: Expected, id: string): string[] {
  const out: string[] = [];
  if (node.title !== expected.title) out.push(`the title is "${node.title}", not "${expected.title}"`);
  if (node.parentId !== expected.parentId) out.push('the document is not under the requested parent');
  if (getBody(state, id) !== expected.body) out.push('the stored body is not the body that was sent');
  if (!keepsBody(getBody(state, id), frontMatterOf(node))) out.push('the body does not come back unchanged from a save and reload');
  if (expected.synopsis !== undefined && node.synopsis !== expected.synopsis) out.push('the synopsis does not match');
  if (expected.status !== undefined && node.status !== expected.status) out.push('the status does not match');
  if (expected.label !== undefined && node.label !== expected.label) out.push('the label does not match');
  if (expected.keywords !== undefined) {
    const stored = new Set(node.keywords.map((keyword) => keyword.toLowerCase()));
    const missing = expected.keywords.filter((keyword) => !stored.has(keyword.toLowerCase()));
    if (missing.length > 0) out.push(`keywords are missing: ${missing.join(', ')}`);
  }
  return out;
}
