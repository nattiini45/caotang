/**
 * The binder nodes each tool reads and writes — the `targets` of a registry row ([agent-harness.md §4](../../../docs/architecture/agent-harness.md),
 * "Rules"), which a rule's subtree is matched against.
 *
 * Every row declares one of two things, and `test/rules-targets.test.ts` holds that for every row:
 *
 * - `'project'`: the call names no node. Either it is not about the binder at all (`tool.search`, `vocabulary.upsert`), or it
 *   reads the whole project and keeps what a read-deny withholds out of its own answer (`project.overview`, `binder.read_tree`,
 *   `codex.read`, the scans), so a scoped rule has nothing to match and the tool does the withholding itself.
 * - a function: the nodes the call's params name, resolved the way the tool resolves them (a title or an id), so the rule and the
 *   tool cannot disagree about which node a call means. A function that cannot resolve a name returns the tool's own refusal; the
 *   harness then refuses the call when a scoped rule could apply to it.
 *
 * `export.compile` is a `'project'` row on purpose: it writes only to `exports/` and sends nothing to a provider, so a read-deny
 * does not stop it (decisions.md, agent rules).
 */

import { ok, type CommandError, type Result } from '@caotang/bus';
import { resolveContainer } from '@caotang/dialogue';
import type { ProjectState } from '@caotang/store';

import { failure } from './errors.js';
import { resolveNode, CONTAINER, DOCUMENT, TARGET, type NodeFilter } from './resolve.js';
import type { CallTargets } from './rules.js';
import type { ToolName } from './metadata.js';
import type { CallParams } from './types.js';

export type TargetsFn = (params: CallParams, state: ProjectState) => Result<CallTargets, CommandError>;

/** A row's targets: a function, or `'project'` when the call names no node. */
export type ToolTargets = 'project' | TargetsFn;

const NONE: CallTargets = Object.freeze({ reads: [], writes: [] });

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The ids of the nodes a list of references names, or the first reference the tool would refuse. */
function resolveAll(state: ProjectState, refs: readonly string[], filter: NodeFilter, noun: string, at: string): Result<string[], CommandError> {
  const ids: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const node = resolveNode(state, ref, filter, noun, `${at}[${index}]`);
    if (!node.ok) return node;
    ids.push(node.value.id);
  }
  return ok(ids);
}

function oneDoc(access: 'reads' | 'writes' | 'both', key = 'doc'): TargetsFn {
  return (params, state) => {
    const node = resolveNode(state, text(params[key]), DOCUMENT, 'document', `params.${key}`);
    if (!node.ok) return node;
    const ids = [node.value.id];
    return ok({ reads: access === 'writes' ? [] : ids, writes: access === 'reads' ? [] : ids });
  };
}

/** A dialogue container, resolved the way `dialogue.draft` and `dialogue.table` resolve it (its own kinds, not the document filter). */
function oneContainer(access: 'reads' | 'both'): TargetsFn {
  return (params, state) => {
    const resolved = resolveContainer(state, text(params['doc']));
    if (!resolved.ok) return failure(resolved.error);
    const ids = [resolved.node.id];
    return ok({ reads: ids, writes: access === 'reads' ? [] : ids });
  };
}

/** Documents named in a list param, read and/or written. */
function docList(key: string, access: 'reads' | 'writes' | 'both'): TargetsFn {
  return (params, state) => {
    const ids = resolveAll(state, strings(params[key]), DOCUMENT, 'document', key);
    if (!ids.ok) return ids;
    return ok({ reads: access === 'writes' ? [] : ids.value, writes: access === 'reads' ? [] : ids.value });
  };
}

/** Node ids a param names directly (shot ids, attachments): used as given, since the tool takes ids only. */
function idList(key: string, access: 'reads' | 'writes' | 'both'): TargetsFn {
  return (params) => {
    const ids = strings(params[key]);
    return ok({ reads: access === 'writes' ? [] : ids, writes: access === 'reads' ? [] : ids });
  };
}

const restructure: TargetsFn = (params) => {
  const writes: string[] = [];
  const opOf: Record<string, number> = {};
  const touch = (id: unknown, index: number): void => {
    if (typeof id !== 'string' || id in opOf) return;
    opOf[id] = index;
    writes.push(id);
  };
  const ops = Array.isArray(params['ops']) ? (params['ops'] as unknown[]) : [];
  for (const [index, op] of ops.entries()) {
    if (typeof op !== 'object' || op === null) continue;
    const fields = op as Record<string, unknown>;
    touch(fields['parent'], index);
    touch(fields['node'], index);
    touch(fields['newParent'], index);
  }
  return ok({ reads: [], writes, opOf });
};

const codexWrite: TargetsFn = (params) => {
  const writes: string[] = [];
  for (const entry of Array.isArray(params['entries']) ? (params['entries'] as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    writes.push(...strings(fields['attachTo']), ...strings(fields['detachFrom']));
  }
  return ok({ reads: [], writes });
};

const codexImport: TargetsFn = (params) => {
  const writes: string[] = [];
  for (const entry of Array.isArray(params['entries']) ? (params['entries'] as unknown[]) : []) {
    if (typeof entry === 'object' && entry !== null) writes.push(...strings((entry as Record<string, unknown>)['attachTo']));
  }
  return ok({ reads: [], writes });
};

/** A coherence scope names documents only in `doc` mode; `changed` and `full` read the manuscript, which the engine filters itself. */
const coherenceScope: TargetsFn = (params) => {
  const scope = params['scope'];
  if (typeof scope !== 'object' || scope === null) return ok(NONE);
  return ok({ reads: strings((scope as Record<string, unknown>)['docIds']), writes: [] });
};

const readTree: TargetsFn = (params, state) => {
  const id = typeof params['root'] === 'string' ? params['root'] : 'root';
  return state.manifest.tree.some((node) => node.id === id) ? ok({ reads: [id], writes: [] }) : ok(NONE);
};

/** A goal sits on the manuscript or a folder (the filter `goal.save` resolves with). */
const GOAL_TARGET: NodeFilter = (node) => node.type === 'folder' || node.id === 'manuscript';

const goalSave: TargetsFn = (params, state) => {
  const node = resolveNode(state, text(params['node']), GOAL_TARGET, 'folder or the manuscript', 'params.node');
  return node.ok ? ok({ reads: [], writes: [node.value.id] }) : node;
};

const docImport: TargetsFn = (params, state) => {
  const parent = resolveNode(state, text(params['parent']), CONTAINER, 'folder', 'params.parent');
  return parent.ok ? ok({ reads: [], writes: [parent.value.id] }) : parent;
};

const metaSet: TargetsFn = (params, state) => {
  const ids = resolveAll(state, strings(params['targets']), TARGET, 'document or folder', 'targets');
  return ids.ok ? ok({ reads: [], writes: ids.value }) : ids;
};

const synopsisSet: TargetsFn = (params, state) => {
  const node = resolveNode(state, text(params['doc']), TARGET, 'document or folder', 'params.doc');
  return node.ok ? ok({ reads: [], writes: [node.value.id] }) : node;
};

export const TOOL_TARGETS: Readonly<Record<ToolName, ToolTargets>> = {
  'project.overview': 'project',
  'binder.read_tree': readTree,
  'doc.read': oneDoc('reads'),
  'notes.read': oneDoc('reads'),
  'meta.set': metaSet,
  'notes.append': oneDoc('writes'),
  'synopsis.fill': docList('docs', 'both'),
  'scene.draft': oneDoc('both'),
  'binder.restructure': restructure,
  'continuity.scan': docList('scope', 'reads'),
  'export.compile': 'project',
  'codex.read': 'project',
  'codex.write': codexWrite,
  'agent.plan': 'project',
  'doc.import': docImport,
  'codex.import': codexImport,
  'coherence.scan': coherenceScope,
  'coherence.review': coherenceScope,
  'coherence.setFindingStatus': 'project',
  'tool.search': 'project',
  'shots.derive': oneDoc('both'),
  'shots.annotate': idList('shots', 'writes'),
  'prompt.draft': idList('shots', 'both'),
  'prompt.variant': (params) => ok({ reads: strings([params['shot']]), writes: [] }),
  'dialogue.draft': oneContainer('both'),
  'dialogue.table': oneContainer('reads'),
  'skill.load': 'project',
  'agent.delegate': docList('scope', 'reads'),
  'notes.replace': oneDoc('writes'),
  'synopsis.set': synopsisSet,
  'vocabulary.upsert': 'project',
  'filter.save': 'project',
  'goal.save': goalSave,
};
