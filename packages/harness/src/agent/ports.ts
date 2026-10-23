/**
 * The injected implementations of the four port tools (agent-harness §3), and the cards that show
 * what they will do.
 *
 * - `codex.read` is a read: `@caotang/codex`'s `codexRead`, over the codex the manifest holds.
 * - `scene.draft` applies a drafted scene. Its one write is `editor.replaceRange`, dispatched under
 *   the tool's own grant (command-bus §4, grant inheritance), after a TextAnchor is resolved with
 *   `@caotang/editor`'s ladder (edit-anchors §3). The ladder is the same code the editor's anchored
 *   apply uses; the sync port calls `resolveAnchor` directly because the library preload is async, so
 *   the loop awaits it before the step runs.
 * - `synopsis.fill` writes one `binder.setSynopsis` per document, after every document has been
 *   resolved and every synopsis checked, so a bad document or an over-long synopsis writes nothing.
 * - `continuity.scan` is a read: the findings the loop drafted, after the closed-set check.
 *
 * None of these calls a model. A port that needs a draft finds it in `context.proposal` and refuses
 * with `needs_input` when there is none, so a port can never generate its own text.
 */

import { err, ok, type CommandError, type Result } from '@caotang/bus';
import type { ReviewPlan } from '@caotang/coherence';
import { codexRead, type CodexReadQuery } from '@caotang/codex';
import { dialogueDraftTool } from '@caotang/dialogue';
import { resolveAnchor, type TextAnchor } from '@caotang/editor';
import { getBody, getRevision, nodeById, type CodexEntry, type ProjectState } from '@caotang/store';
import { deriveShotsTool, shotFieldOf, specRowOf, type DerivePlan } from '@caotang/storyboard';
import { commitPromptDraftTool, type PromptDraftProposal, type VariantProposal } from '@caotang/video-prompt-pack';

import { failure, refusal } from '../errors.js';
import { DOCUMENT, descendantsOf, resolveNode } from '../resolve.js';
import type { CallParams, PortContext, PortToolName, ToolPort, ToolValue } from '../types.js';
import { batchRefusal } from '../tools/common.js';
import { delegatePort } from '../tools/delegate.js';
import { asFindingsProposal, asSceneProposal, asSynopsisProposal, wordsOf } from './drafting.js';
import { storyboardOf } from './storyboard-model.js';

/** Synopsis limit, project-format §2 (the bus enforces it too; checked here so a batch refuses before its first write). */
const SYNOPSIS_MAX = 2000;

/** The refusal for a port that was called with nothing staged for it. `needs_input` is the code the ladder reads. */
function nothingStaged(tool: string, what: string): CommandError {
  return refusal('invalid-params', `${tool} has no ${what} to apply: the agent drafts it before the step runs, and none was staged for this call`, {
    correctiveHint: `ask the agent to produce the ${what} again`,
    target: tool,
  });
}

/**
 * The refusal for a proposal the provider cut at its output limit (agent-harness §8). Cut text reaches
 * a port only through a plan-card apply the writer accepted with `acceptTruncated`, which strips `cut`
 * from the proposal before the step runs (loop.ts); a call that still carries `cut: true` is a direct
 * call without that acceptance — refuse it, name the cut, and write nothing. One rule for every
 * model-backed write port, so none of them can apply a truncated proposal.
 */
function cutRefusal(tool: string, what: string): CommandError {
  return refusal('invalid-params', `this ${what} was cut off at the model’s output limit, so it cannot be applied as-is`, {
    correctiveHint: `retry the ${what}, or apply through the plan card with acceptTruncated to keep the cut text`,
    target: tool,
  });
}

/** `codex.read` — codex.md §7, over the manifest's codex. Read-only; an empty result is a result, not a refusal. */
export const codexReadPort: ToolPort = (params, context) => {
  const entries = (context.state.manifest.codex ?? []) as readonly CodexEntry[];
  const query: CodexReadQuery = {
    ...(typeof params['query'] === 'string' ? { query: params['query'] } : {}),
    ...(typeof params['type'] === 'string' ? { type: params['type'] } : {}),
    ...(typeof params['includePolicy'] === 'string' ? { includePolicy: params['includePolicy'] as CodexReadQuery['includePolicy'] } : {}),
    ...(typeof params['id'] === 'string' ? { id: params['id'] } : {}),
    ...(typeof params['limit'] === 'number' ? { limit: params['limit'] } : {}),
  };
  const result = codexRead(query, { entries });
  const count = result.entries.length;
  return ok({
    data: {
      entries: result.entries,
      total: result.total,
      truncated: result.truncated,
      ...(result.note === undefined ? {} : { note: result.note }),
    },
    summary: `read ${count} of ${result.total} codex ${result.total === 1 ? 'entry' : 'entries'}`,
    affected: [],
    ...(result.note === undefined ? {} : { notes: [result.note] }),
  });
};

/**
 * The mode rule of a draft, against the body it would land in (agent-harness §3): a draft replaces an empty body only, and a
 * body with text is refused with what the writer can do instead. One check serves the call (`sceneDraftPort`), a plan's
 * preflight (runtime.ts `prepareCall`) and the draft itself (loop.ts `draftStep`), so none of the three can disagree.
 */
export function draftModeRefusal(mode: string, body: string): CommandError | undefined {
  if (mode !== 'draft' || body.trim() === '') return undefined;
  return refusal('invalid-params', `mode draft needs an empty document, and this one already has ${wordsOf(body)} words, so nothing was written`, {
    correctiveHint: 'set mode to continue to add to the end, or select a passage to rewrite it',
    target: 'params.mode',
  });
}

/**
 * The state check of a `scene.draft` step: the mode rule against the document the step names. The rule depends on the body,
 * so a card made from the step's params alone would approve a step the apply refuses. A document that does not resolve is
 * named here, at preflight, so a plan card cannot promise a step the apply would refuse on its way out (bus-05-agent).
 */
export function sceneDraftPreflight(params: CallParams, state: ProjectState): CommandError | undefined {
  const node = resolveNode(state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return node.error;
  const mode = typeof params['mode'] === 'string' ? params['mode'] : 'draft';
  return draftModeRefusal(mode, getBody(state, node.value.id));
}

/**
 * The derive a `shots.derive` step makes from its params and the proposal staged for it (storyboard.md §4): planned against the scene
 * as it stands, and changing nothing. Undefined while nothing is staged — that is "no proposal yet", not "the scene is gone";
 * a scene that does not resolve returns the not-found error here, at preflight, so a plan card never promises a derive the apply
 * would refuse on its way out (bus-05-agent). Shared by the preflight and the card's preview, so a card shows the plan the apply
 * would make, and no other.
 */
function shotsPlanOf(params: CallParams, state: ProjectState, proposal: unknown): Result<DerivePlan, CommandError> | undefined {
  if (proposal === undefined) return undefined;
  const node = resolveNode(state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return err(node.error);
  const planned = deriveShotsTool({ ...params, doc: node.value.id }, { state, presentAssets: new Set(), proposal });
  return planned.ok ? ok(planned.value.plan) : err(planned.error);
}

/**
 * The state check of a `shots.derive` step: the proposal, planned against the scene it names. A proposal the storyboard module
 * refuses (a malformed shot, too many, a prose scene, an empty one, or a scene that is no longer there) is refused here, so the
 * card cannot approve a derive its apply would refuse (agent-harness §2, bus-05-agent). The check is pure, so the port runs it
 * again without a second write. The scene check (`shotsDeriveScenePreflight`) runs first, so a deleted scene is refused even
 * before the model has staged a proposal for it.
 */
function shotsDerivePreflight(params: CallParams, state: ProjectState, proposal?: unknown): CommandError | undefined {
  const sceneRefusal = shotsDeriveScenePreflight(params, state);
  if (sceneRefusal !== undefined) return sceneRefusal;
  const planned = shotsPlanOf(params, state, proposal);
  return planned === undefined || planned.ok ? undefined : planned.error;
}

/** The storyboard's refusals of a derive that are about the scene, not the shots: a prose scene, one with no folder, an empty one. */
const SCENE_REFUSALS: ReadonlySet<string> = new Set(['not-screenplay', 'doc-orphan', 'doc-empty']);

/**
 * The checks of a `shots.derive` step that need no proposal: the scene it names, planned against with nothing proposed, so the
 * storyboard module's own words refuse a prose scene or an empty one. The loop runs it before the derive's model call (loop.ts
 * `draftStep`), so no call is spent on shots the card's preflight would refuse. A scene that does not resolve is named here, at
 * preflight, so a plan card cannot promise a derive the apply would refuse on its way out (bus-05-agent).
 */
export function shotsDeriveScenePreflight(params: CallParams, state: ProjectState): CommandError | undefined {
  const node = resolveNode(state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return node.error;
  const planned = deriveShotsTool({ ...params, doc: node.value.id }, { state, presentAssets: new Set(), proposal: undefined });
  if (planned.ok) return undefined;
  const code = planned.error.details?.['storyboardCode'];
  return typeof code === 'string' && SCENE_REFUSALS.has(code) ? planned.error : undefined;
}

/**
 * The state checks of the port tools, by name. runtime.ts runs each one in a call, after the gate, and in a plan's preflight, so a
 * plan's preflight refuses a step that its apply would refuse, and the card is not approvable (agent-harness §2).
 */
export const portPreflights: Partial<Record<PortToolName, (params: CallParams, state: ProjectState, proposal?: unknown) => CommandError | undefined>> = {
  'scene.draft': sceneDraftPreflight,
  'shots.derive': shotsDerivePreflight,
};

/** The range a draft occupies, and the text that goes there, for each mode. Pure over the body it is given. */
function placement(
  mode: string,
  body: string,
  text: string,
  revision: number,
  selection: TextAnchor | undefined,
): Result<{ range: { from: number; to: number }; text: string }, CommandError> {
  if (mode === 'draft') {
    const refused = draftModeRefusal(mode, body);
    if (refused !== undefined) return err(refused);
    return ok({ range: { from: 0, to: 0 }, text });
  }
  if (mode === 'continue') {
    // A separator only when the body does not already end in one, so the join reads as a paragraph break.
    const separator = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return ok({ range: { from: body.length, to: body.length }, text: `${separator}${text}` });
  }
  if (selection === undefined) {
    return err(refusal('invalid-params', 'mode rewrite_selection needs a selection anchor, and none was given', { correctiveHint: 'select text in the editor first, or pass a selection anchor', target: 'params.selection' }));
  }
  const resolution = resolveAnchor(selection, body, revision);
  if (resolution.status === 'unresolvable') {
    return err(
      refusal('invalid-params', `the selected text could not be found where it was captured: ${resolution.reason}`, {
        correctiveHint: 'select the text again in the editor, or read the document with doc.read and plan the step again',
        target: 'params.selection',
        details: {
          askBackCode: 'anchor_unresolvable',
          candidates: resolution.candidates,
          revisionDrift: resolution.revisionDrift,
        },
      }),
    );
  }
  return ok({ range: { from: resolution.range.from, to: resolution.range.to }, text });
}

/** `scene.draft` — the drafted text, applied under the tool's grant after anchor resolution, and read back. */
export const sceneDraftPort: ToolPort = (params, context: PortContext) => {
  const proposal = asSceneProposal(context.proposal);
  if (proposal === undefined) return failure(nothingStaged('scene.draft', 'drafted text'));
  if (proposal.text.trim() === '') {
    return failure(refusal('invalid-params', 'the draft is empty, so nothing was written', { correctiveHint: 'draft again with a brief that asks for prose', target: 'scene.draft' }));
  }
  // A draft the provider cut at its output limit (agent-harness §8) is incomplete: the card shows it
  // and the writer either retries or accepts with `acceptTruncated`. The acceptance flows through the
  // plan-step apply, which strips `cut` from the proposal before it reaches the port (loop.ts), so a
  // port call that still carries `cut: true` is the writer's direct call without that acceptance.
  if (proposal.cut === true) return failure(cutRefusal('scene.draft', 'draft'));
  const { state } = context;
  const node = resolveNode(state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return failure(node.error);

  const docId = node.value.id;
  const body = getBody(state, docId);
  const revision = getRevision(state, docId);
  const mode = typeof params['mode'] === 'string' ? params['mode'] : 'draft';
  const selection = params['selection'] as TextAnchor | undefined;
  const placed = placement(mode, body, proposal.text, revision, selection);
  if (!placed.ok) return failure(placed.error);

  const { range, text } = placed.value;
  // The write is `editor.replaceRange`, which is never directly agent-callable. This port holds the grant.
  // Apply carries the revision the draft was staged against, not the one it finds now: a document the
  // user changed while the card was open is a conflict, and the draft is kept for a retry (agent-harness §8).
  const result = context.dispatchInherited('editor.replaceRange', { docId, range, text, expectedRevision: proposal.revision });
  if (!result.ok) return failure(result.error);

  // Verify (agent-harness §7): the body now holds the text where it was placed.
  const expected = body.slice(0, range.from) + text + body.slice(range.to);
  if (getBody(state, docId) !== expected) {
    return failure(
      refusal('postcondition', `the document does not hold the draft where it was placed. The undo group is registered and intact, so this is reversible.`, {
        correctiveHint: 'undo this turn and report the mismatch to the user',
        details: result.value.undoGroupId === undefined ? {} : { undoGroupId: result.value.undoGroupId },
      }),
    );
  }

  const title = node.value.title;
  const words = wordsOf(proposal.text);
  return ok({
    data: { doc: { id: docId, title }, mode, words, range, revision: getRevision(state, docId) },
    summary: `${mode === 'rewrite_selection' ? 'rewrote a passage of' : mode === 'continue' ? 'continued' : 'drafted'} "${title}" (${words} words)`,
    affected: [...result.value.affected],
    ...(result.value.undoGroupId === undefined ? {} : { undoGroupId: result.value.undoGroupId }),
  });
};

/** `synopsis.fill` — every document resolved and every synopsis checked before the first write. */
export const synopsisFillPort: ToolPort = (params, context) => {
  const { state } = context;
  const refs = Array.isArray(params['docs']) ? (params['docs'] as readonly string[]) : [];
  const failures: { target: string; error: CommandError }[] = [];
  const nodes: { id: string; title: string }[] = [];
  for (const [index, ref] of refs.entries()) {
    const node = resolveNode(state, ref, DOCUMENT, 'document', `docs[${index}]`);
    if (!node.ok) failures.push({ target: `docs[${index}]`, error: node.error });
    else nodes.push({ id: node.value.id, title: node.value.title });
  }
  if (failures.length > 0) {
    return failure(batchRefusal(failures, refs.length, 'fix every listed document and resend the call — nothing was written'));
  }

  const proposal = asSynopsisProposal(context.proposal);
  if (proposal === undefined) return failure(nothingStaged('synopsis.fill', 'synopses'));
  // The cut rule of a scene draft holds here too: a batch the provider cut at its output limit is
  // incomplete, and only the plan-card apply the writer accepted strips `cut` before the port runs.
  if (proposal.cut === true) return failure(cutRefusal('synopsis.fill', 'synopsis batch'));
  const byId = new Map(proposal.items.map((item) => [item.docId, item.synopsis]));
  const missing = nodes.filter((node) => !byId.has(node.id));
  if (missing.length > 0) {
    return failure(refusal('invalid-params', `no synopsis was drafted for ${missing.map((node) => `"${node.title}"`).join(', ')}, so nothing was written`, { correctiveHint: 'draft a synopsis for every listed document', target: 'docs' }));
  }
  const tooLong = nodes.filter((node) => (byId.get(node.id) ?? '').length > SYNOPSIS_MAX);
  if (tooLong.length > 0) {
    return failure(refusal('limit-exceeded', `a synopsis is over ${SYNOPSIS_MAX} characters, so nothing was written`, { correctiveHint: 'ask for shorter synopses', target: 'max_words' }));
  }

  const rows: { doc: { id: string; title: string }; action: 'create' | 'replace'; words: number }[] = [];
  const affected: ToolValue['affected'][number][] = [];
  let undoGroupId: string | undefined;
  for (const node of nodes) {
    const synopsis = byId.get(node.id) ?? '';
    const previous = state.manifest.tree.find((candidate) => candidate.id === node.id)?.synopsis ?? '';
    const result = context.dispatch('binder.setSynopsis', { nodeId: node.id, synopsis });
    if (!result.ok) return failure(result.error);
    affected.push(...result.value.affected);
    undoGroupId ??= result.value.undoGroupId;
    rows.push({ doc: node, action: previous.trim() === '' ? 'create' : 'replace', words: wordsOf(synopsis) });
  }
  return ok({
    data: { rows, count: rows.length },
    summary: `set ${rows.length} ${rows.length === 1 ? 'synopsis' : 'synopses'}`,
    affected,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  });
};

/** `continuity.scan` — the drafted findings, checked, and returned. Read-only: nothing is written. */
export const continuityScanPort: ToolPort = (params, context) => {
  const { state } = context;
  const refs = Array.isArray(params['scope']) ? (params['scope'] as readonly string[]) : undefined;
  const failures: { target: string; error: CommandError }[] = [];
  const scope: { id: string; title: string }[] = [];
  if (refs === undefined) {
    for (const node of descendantsOf(state, 'manuscript').filter(DOCUMENT)) scope.push({ id: node.id, title: node.title });
  } else {
    for (const [index, ref] of refs.entries()) {
      const node = resolveNode(state, ref, DOCUMENT, 'document', `scope[${index}]`);
      if (!node.ok) failures.push({ target: `scope[${index}]`, error: node.error });
      else scope.push({ id: node.value.id, title: node.value.title });
    }
  }
  if (failures.length > 0) return failure(batchRefusal(failures, refs?.length ?? 0, 'fix every listed document and resend the call'));

  const proposal = asFindingsProposal(context.proposal);
  if (proposal === undefined) return failure(nothingStaged('continuity.scan', 'findings'));
  const aspects = Array.isArray(params['aspects']) ? (params['aspects'] as readonly string[]) : [];
  return ok({
    data: { scope: scope.map((doc) => doc.title), aspects, findings: proposal.findings, count: proposal.findings.length },
    summary: `${proposal.findings.length} continuity ${proposal.findings.length === 1 ? 'finding' : 'findings'} across ${scope.length} ${scope.length === 1 ? 'document' : 'documents'}`,
    affected: [],
  });
};

/**
 * `shots.derive` — the staged shot list, planned by the storyboard module and applied as its commands in order (storyboard.md §4).
 * The scene is named by a resolved id, as the harness resolves a title, and nothing is written until every command has run.
 */
export const shotsDerivePort: ToolPort = (params, context) => {
  const node = resolveNode(context.state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return failure(node.error);
  if (context.proposal === undefined) return failure(nothingStaged('shots.derive', 'shot list'));
  const planned = deriveShotsTool({ ...params, doc: node.value.id }, { state: context.state, presentAssets: new Set(), proposal: context.proposal });
  if (!planned.ok) return failure(planned.error);

  const affected: ToolValue['affected'][number][] = [];
  let undoGroupId: string | undefined;
  for (const command of planned.value.commands) {
    const result = context.dispatch(command.name, command.params as unknown as CallParams);
    if (!result.ok) return failure(result.error);
    affected.push(...result.value.affected);
    undoGroupId ??= result.value.undoGroupId;
  }
  const { plan } = planned.value;
  return ok({
    data: { folder: plan.folderTitle, scene: plan.sceneTitle, shots: plan.shots.length },
    summary: `derived ${plan.shots.length} ${plan.shots.length === 1 ? 'shot' : 'shots'} for "${plan.sceneTitle}" into "${plan.folderTitle}"`,
    affected,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  });
};

/**
 * `prompt.draft` — the staged prompts, written as each shot's vendor record through `shot.setMeta` (video-prompt-pack.md §6). The
 * commit checks every shot's record against the draft's base, so a shot changed since the draft is refused and nothing is written.
 */
export const promptDraftPort: ToolPort = (_params, context) => {
  const proposal = context.proposal as PromptDraftProposal | undefined;
  if (proposal === undefined) return failure(nothingStaged('prompt.draft', 'prompt drafts'));
  const committed = commitPromptDraftTool(proposal, { storyboard: storyboardOf(context.state) });
  if (!committed.ok) {
    return failure(
      refusal(committed.code === 'conflict' ? 'revision-conflict' : 'invalid-params', committed.message, { correctiveHint: 'draft those shots again', target: 'prompt.draft' }),
    );
  }

  const affected: ToolValue['affected'][number][] = [];
  let undoGroupId: string | undefined;
  for (const write of committed.data.writes) {
    const node = nodeById(context.state, write.shotId);
    const stored = node === undefined ? undefined : shotFieldOf(node);
    const current = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
    // The whole stored value is written, with the vendor record replaced; `expect` is the value it replaces, so a shot that moved is refused.
    const result = context.dispatch('shot.setMeta', { nodeId: write.shotId, stored: { ...(current ?? {}), vendorRefs: [...write.vendorRefs] }, expect: current });
    if (!result.ok) return failure(result.error);
    affected.push(...result.value.affected);
    undoGroupId ??= result.value.undoGroupId;
  }
  return ok({
    data: { vendor: proposal.vendor, writes: committed.data.writes.length },
    summary: committed.summary,
    affected,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  });
};

/**
 * `dialogue.draft` — the staged Ink, checked by the dialogue module and written into the container as one document write under the
 * tool's grant (dialogue-narrative.md §7). The write carries the revision the Ink was drafted against, so a container the writer
 * changed meanwhile is a conflict and the draft is kept for a retry, as a scene draft is.
 */
export const dialogueDraftPort: ToolPort = (params, context) => {
  const proposal = context.proposal as { readonly ink?: unknown; readonly revision?: unknown; readonly cut?: unknown } | undefined;
  if (typeof proposal?.ink !== 'string' || typeof proposal.revision !== 'number') return failure(nothingStaged('dialogue.draft', 'Ink'));
  // The cut rule of a scene draft holds here too: Ink the provider cut at its output limit is
  // incomplete, and only the plan-card apply the writer accepted strips `cut` before the port runs.
  if (proposal.cut === true) return failure(cutRefusal('dialogue.draft', 'Ink draft'));
  const checked = dialogueDraftTool(params, { state: context.state, proposal: { ink: proposal.ink } });
  if (!checked.ok) return failure(checked.error);
  const docId = String(checked.value.data['containerId']);
  const body = String(checked.value.data['body']);
  const result = context.dispatchInherited('doc.write', { docId, body, expectedRevision: proposal.revision });
  if (!result.ok) return failure(result.error);
  // Verify (agent-harness §7): the container now holds the Ink it was checked as.
  if (getBody(context.state, docId) !== body) {
    return failure(
      refusal('postcondition', 'the container does not hold the drafted Ink where it was written. The undo group is registered and intact, so this is reversible.', {
        correctiveHint: 'undo this turn and report the mismatch to the user',
        details: result.value.undoGroupId === undefined ? {} : { undoGroupId: result.value.undoGroupId },
      }),
    );
  }
  return ok({
    data: { container: checked.value.data['title'], newBeats: checked.value.data['newBeats'], warnings: checked.value.data['warnings'] },
    summary: checked.value.summary,
    affected: [...result.value.affected],
    ...(result.value.undoGroupId === undefined ? {} : { undoGroupId: result.value.undoGroupId }),
  });
};

/** `prompt.variant` — the staged alternatives, returned as data. A read: nothing is written until the writer picks one (video-prompt-pack.md §6). */
export const promptVariantPort: ToolPort = (_params, context) => {
  if (context.proposal === undefined) return failure(nothingStaged('prompt.variant', 'alternatives'));
  const proposal = context.proposal as VariantProposal;
  return ok({
    data: { ...(proposal as unknown as Record<string, unknown>) },
    summary: `three ${proposal.variation} alternatives for shot ${proposal.shotNumber}. Nothing is written until one is picked.`,
    affected: [],
  });
};

/** The ports this package provides. The raw harness injects nothing; the agent session injects these. */
export function createAgentPorts(): Partial<Record<PortToolName, ToolPort>> {
  return {
    'codex.read': codexReadPort,
    'scene.draft': sceneDraftPort,
    'synopsis.fill': synopsisFillPort,
    'continuity.scan': continuityScanPort,
    'shots.derive': shotsDerivePort,
    'prompt.draft': promptDraftPort,
    'prompt.variant': promptVariantPort,
    'dialogue.draft': dialogueDraftPort,
    // The loop answers a delegation inside a turn; the port is the refusal a call outside one gets (tools/delegate.ts).
    'agent.delegate': delegatePort,
  };
}

/* ------------------------------------------------------------------ *
 * Previews — what a card shows for a step, before it runs.
 * ------------------------------------------------------------------ */

/**
 * The card's preview of one staged step. Pure over the state and the proposal, so the card can show
 * exactly what the port will apply: the drafted text, the synopsis rows, or the findings. Undefined
 * for a step with nothing to preview.
 */
export function previewFor(state: ProjectState, tool: string, params: CallParams, proposal: unknown): unknown {
  if (tool === 'scene.draft') {
    const draft = asSceneProposal(proposal);
    const node = resolveNode(state, String(params['doc']), DOCUMENT, 'document', 'params.doc');
    if (draft === undefined || !node.ok) return undefined;
    const body = getBody(state, node.value.id);
    const selection = params['selection'] as TextAnchor | undefined;
    return {
      doc: node.value.title,
      mode: typeof params['mode'] === 'string' ? params['mode'] : 'draft',
      words: draft.words,
      currentWords: wordsOf(body),
      text: draft.text,
      ...(selection === undefined ? {} : { selection: { exact: selection.exact, prefix: selection.prefix, suffix: selection.suffix } }),
    };
  }
  if (tool === 'synopsis.fill') {
    const batch = asSynopsisProposal(proposal);
    if (batch === undefined) return undefined;
    const rows = batch.items.map((item) => {
      const node = state.manifest.tree.find((candidate) => candidate.id === item.docId);
      const previous = node?.synopsis ?? '';
      return { doc: node?.title ?? item.docId, action: previous.trim() === '' ? 'create' : 'replace', synopsis: item.synopsis, words: wordsOf(item.synopsis) };
    });
    return { rows };
  }
  if (tool === 'continuity.scan') {
    const found = asFindingsProposal(proposal);
    return found === undefined ? undefined : { findings: found.findings };
  }
  if (tool === 'dialogue.draft') {
    // The drafted Ink and what the dialogue module says about it, as the card shows it (dialogue-narrative.md §7).
    const drafted = proposal as { readonly ink?: unknown } | undefined;
    if (typeof drafted?.ink !== 'string') return undefined;
    const checked = dialogueDraftTool(params, { state, proposal: { ink: drafted.ink } });
    if (!checked.ok) return undefined;
    return { container: checked.value.data['title'], ink: drafted.ink, newBeats: checked.value.data['newBeats'], warnings: checked.value.data['warnings'] };
  }
  if (tool === 'shots.derive') {
    // The shot list and the storyboard folder an approved derive creates (storyboard.md §4), planned from the staged proposal. A plan the
    // storyboard module refuses has no list here: its preflight names the refusal on the step.
    const planned = shotsPlanOf(params, state, proposal);
    if (planned === undefined || !planned.ok) return undefined;
    const plan = planned.value;
    return {
      folder: plan.folderTitle,
      shots: plan.shots.map((shot) => ({ number: shot.number, title: shot.title, spec: specRowOf(shot.stored) })),
      lines: plan.treeDiff,
      notes: plan.notes,
    };
  }
  if (tool === 'coherence.review') {
    // The review's plan (coherence.md §7 tool 16): the documents it reads, its cost bound and the first prompt, as the card shows them.
    const plan = proposal as ReviewPlan | undefined;
    if (plan === undefined || !Array.isArray(plan.documents)) return undefined;
    return {
      documents: plan.documents.map((doc) => ({
        title: doc.title,
        tokens: doc.estimatedTokens,
        truncated: doc.truncated,
        codexDropped: [...doc.codexDropped],
        storyDropped: [...doc.storyDropped],
      })),
      categories: [...plan.categories],
      maxFindings: plan.maxFindings,
      estimate: { ...plan.estimate },
      overGuard: plan.overGuard,
      promptPreview: plan.promptPreview,
    };
  }
  return undefined;
}
