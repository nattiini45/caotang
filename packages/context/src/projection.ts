import { countBody, getBody, type CodexEntry, type DocumentRecord, type ProjectState, type TreeNode } from '@caotang/store';
import { focusScope } from '@caotang/codex';

import { resolveFocus, resolveScope } from './assemble.js';
import { overrideIds, pinnedNodes } from './overrides.js';
import { profileFor, SCOPE_DOCUMENT_LIMIT, TURN_LIMIT } from './profiles.js';
import { enclosingFolders, earlierSiblings, indexTree, manuscriptDocuments } from './tree.js';
import { utcClock } from './layers/turns.js';
import { memoryReadable, summaryPrefix } from './session-summary.js';
import { entryWithheld, scrubbed, scrubbedRow, scrubbedTurn, withheldReadPolicy } from './withheld.js';
import type { ActivityEntry } from '@caotang/bus';
import { LAYER_IDS, type AgentTask, type AppSnapshot, type ContextConfig, type ContextOverrides, type LayerId, type ModelLimits, type RecentTurn, type SessionSummary } from './types.js';

export interface SerializedContextConfig {
  readonly contextBudget?: number;
  readonly layerBudgets?: Readonly<Partial<Record<LayerId, number>>>;
  readonly continuationChars?: number;
  readonly focusFlowUp?: boolean;
  readonly responseFormat?: 'text' | { readonly jsonSchemaHint: object };
  readonly model?: ModelLimits;

  readonly restoredTimes: Readonly<Record<string, string>>;
}

export interface ProjectedContextInput {
  readonly task: AgentTask;
  readonly app: AppSnapshot;
  readonly config: SerializedContextConfig;
}

const PIN_WINDOW = 3;

function bodyReads(task: AgentTask, state: ProjectState, hidden: ReadonlySet<string>): Set<string> {
  const fullTree = indexTree(state.manifest.tree);
  const tree = hidden.size === 0 ? fullTree : indexTree(state.manifest.tree.filter((node) => !hidden.has(node.id)));
  const readable = task.scope === undefined ? task : { ...task, scope: task.scope.filter((id) => !hidden.has(id)) };
  const ids = new Set<string>();
  const focus = resolveFocus(task, fullTree);
  if (focus !== undefined && !hidden.has(focus.id)) ids.add(focus.id);
  for (const node of resolveScope(readable, tree).slice(0, SCOPE_DOCUMENT_LIMIT)) ids.add(node.id);
  for (const node of pinnedNodes(readable.overrides, tree).nodes.slice(0, PIN_WINDOW)) ids.add(node.id);
  return ids;
}

function synopsisReads(task: AgentTask, state: ProjectState, hidden: ReadonlySet<string>): Set<string> {
  const fullTree = indexTree(state.manifest.tree);
  const tree = hidden.size === 0 ? fullTree : indexTree(state.manifest.tree.filter((node) => !hidden.has(node.id)));
  const readable = task.scope === undefined ? task : { ...task, scope: task.scope.filter((id) => !hidden.has(id)) };
  const excluded = overrideIds(task.overrides, 'exclude', 'doc');
  const profile = profileFor(task.tool);
  const ids = new Set<string>();
  const resolved = resolveFocus(task, fullTree);
  const focus = resolved !== undefined && !hidden.has(resolved.id) ? resolved : undefined;
  if (focus !== undefined) ids.add(focus.id);
  for (const node of pinnedNodes(readable.overrides, tree).nodes.slice(0, PIN_WINDOW)) ids.add(node.id);
  if (profile.layers.includes('L3') && focus !== undefined) {
    for (const node of enclosingFolders(tree, focus)) ids.add(node.id);
    for (const node of earlierSiblings(tree, focus)) if (!excluded.has(node.id)) ids.add(node.id);
  }
  if (profile.layers.includes('L4')) {
    const sequence = manuscriptDocuments(tree);
    if (task.tool === 'continuity.scan' || task.tool === 'delegate') {
      const scope = resolveScope(readable, tree);
      const inScope = new Set(scope.map((node) => node.id));
      const first = scope[0];
      const position = first === undefined ? -1 : sequence.findIndex((node) => node.id === first.id);
      const earlier = position === -1 ? [] : sequence.slice(0, position).filter((node) => !inScope.has(node.id));
      for (const node of [...scope.slice(SCOPE_DOCUMENT_LIMIT), ...earlier]) if (!excluded.has(node.id)) ids.add(node.id);
    } else if (focus !== undefined) {
      const position = sequence.findIndex((node) => node.id === focus.id);
      const earlier = position === -1 ? [] : sequence.slice(0, position);
      for (const node of earlier) if (!excluded.has(node.id)) ids.add(node.id);
      if (task.includeForwardOutline === true && position !== -1) for (const node of sequence.slice(position + 1)) if (!excluded.has(node.id)) ids.add(node.id);
    }
  }
  return ids;
}

function codexDescriptionReads(task: AgentTask, state: ProjectState, hidden: ReadonlySet<string>): Set<string> {
  const pins = overrideIds(task.overrides, 'include', 'codex');
  if (!profileFor(task.tool).layers.includes('L2') && pins.size === 0) return new Set();
  const entries = state.manifest.codex ?? [];
  const fullTree = indexTree(state.manifest.tree);
  const tree = hidden.size === 0 ? fullTree : indexTree(state.manifest.tree.filter((node) => !hidden.has(node.id)));
  const readable = task.scope === undefined ? task : { ...task, scope: task.scope.filter((id) => !hidden.has(id)) };
  const resolved = resolveFocus(task, fullTree);
  const focus = resolved !== undefined && !hidden.has(resolved.id) ? resolved : undefined;
  const scopeNodes = resolveScope(readable, tree).slice(0, SCOPE_DOCUMENT_LIMIT);
  const exclusions = overrideIds(task.overrides, 'exclude', 'codex');
  const focusDocs = scopeNodes.length > 0 ? scopeNodes.map((node) => node.id) : focus === undefined ? [] : [focus.id];
  const scopes = focusDocs.map((id) => focusScope(state.manifest.tree, id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entryWithheld(entry, hidden) || entry.includePolicy === 'never' || exclusions.has(entry.id)) continue;
    const attached = entry.includePolicy === 'manual' && scopes.some((scope) => scope.some((node) => entry.attachments.includes(node)));
    if (entry.includePolicy !== 'manual' || pins.has(entry.id) || attached) ids.add(entry.id);
  }
  return ids;
}

function projectNode(node: TreeNode, hidden: ReadonlySet<string>, focusId: string | undefined, synopsisIds: ReadonlySet<string>): TreeNode {
  const base = { id: node.id, parentId: node.parentId, type: node.type, title: node.title, order: node.order, status: node.status, label: null, keywords: [] as string[] };
  if (hidden.has(node.id)) return { ...base, synopsis: '', notes: '' };
  return { ...base, synopsis: synopsisIds.has(node.id) ? node.synopsis : '', notes: node.id === focusId ? node.notes : '' };
}

function projectEntry(entry: CodexEntry, hidden: ReadonlySet<string>, descriptionIds: ReadonlySet<string>): CodexEntry {
  const base = { id: entry.id, name: entry.name, type: entry.type, includePolicy: entry.includePolicy, attachments: [...entry.attachments], keywords: [] as string[], origin: 'manual' as const, sources: [] as CodexEntry['sources'], caseSensitive: false, exclude: [] as string[], aliases: [] as string[], description: '' };
  if (entryWithheld(entry, hidden)) return base;
  const detection = { ...base, aliases: [...entry.aliases], caseSensitive: entry.caseSensitive, exclude: [...entry.exclude] };
  if (entry.includePolicy === 'never') return detection;
  return descriptionIds.has(entry.id) ? { ...detection, description: entry.description } : detection;
}

function projectAgentFiles(state: ProjectState): ProjectState['agentFiles'] {
  const files = state.agentFiles;
  return {
    ...(files.instructions === undefined ? {} : { instructions: { path: files.instructions.path, text: files.instructions.text } }),
    ...(files.index === undefined ? {} : { index: files.index }),
    memory: [],
    declined: new Map([...files.declined.keys()].map((path) => [path, ''] as const)),
    unreadable: [...files.unreadable],
  };
}

function projectTurn(turn: RecentTurn): RecentTurn {
  return {
    turnId: turn.turnId,
    intent: turn.intent,
    ...(turn.outcome === undefined ? {} : { outcome: turn.outcome }),
    ...(turn.undoGroupId === undefined ? {} : { undoGroupId: turn.undoGroupId }),
    ...(turn.restoredAt === undefined ? {} : { restoredAt: turn.restoredAt }),
    ...(turn.restoredFromStep === undefined ? {} : { restoredFromStep: turn.restoredFromStep }),
    ...(turn.rewound === undefined ? {} : { rewound: turn.rewound }),
    ...(turn.hidden === undefined ? {} : { hidden: turn.hidden }),
    ...(turn.external === undefined ? {} : { external: turn.external }),
    ...(turn.readPolicy === undefined ? {} : { readPolicy: turn.readPolicy }),
  };
}

function projectActivity(row: ActivityEntry): ActivityEntry {
  return {
    at: row.at,
    command: row.command,
    issuedBy: row.issuedBy,
    source: row.source,
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    ...(row.callId === undefined ? {} : { callId: row.callId }),
    ...(row.undoGroupId === undefined ? {} : { undoGroupId: row.undoGroupId }),
    affected: row.affected.map((node) => ({ nodeId: node.nodeId, title: node.title })),
    summary: row.summary,
  };
}

function projectSummary(summary: SessionSummary, text: string): SessionSummary {
  return {
    version: summary.version,
    covers: { from: summary.covers.from, to: summary.covers.to, turns: summary.covers.turns },
    text,
    origin: summary.origin,
    external: summary.external,
    ...(summary.readPolicy === undefined ? {} : { readPolicy: summary.readPolicy }),
  };
}

function projectState(task: AgentTask, state: ProjectState, hidden: ReadonlySet<string>): ProjectState {
  const tree = indexTree(state.manifest.tree);
  const focus = resolveFocus(task, tree);
  const focusId = focus?.id;
  const bodies = bodyReads(task, state, hidden);
  const synopsisIds = synopsisReads(task, state, hidden);
  const descriptionIds = codexDescriptionReads(task, state, hidden);

  const documents = new Map<string, DocumentRecord>();
  for (const id of bodies) {
    const record = state.documents.get(id);
    if (record !== undefined) documents.set(id, { id: record.id, body: record.body, revision: record.revision });
  }

  const wordCounts: Record<string, number> = {};
  for (const node of state.manifest.tree) {
    if (node.type !== 'document' || hidden.has(node.id)) continue;
    const held = state.manifest.derived.wordCounts[node.id];
    wordCounts[node.id] = held !== undefined ? held : countBody(getBody(state, node.id)).words;
  }

  const identity = state.manifest.project;
  return {
    manifest: {
      app: state.manifest.app,
      formatVersion: state.manifest.formatVersion,
      project: { id: identity.id, name: identity.name, createdAt: identity.createdAt, modifiedAt: identity.modifiedAt, ...(identity.language === undefined ? {} : { language: identity.language }) },
      vocabulary: {
        statuses: state.manifest.vocabulary.statuses.map((term) => ({ id: term.id, name: term.name, color: '' })),
        labels: state.manifest.vocabulary.labels.map((term) => ({ id: term.id, name: term.name, color: '' })),
      },
      tree: state.manifest.tree.map((node) => projectNode(node, hidden, focusId, synopsisIds)),
      derived: { wordCounts, computedAt: state.manifest.derived.computedAt, ...(state.manifest.derived.ruleVersion === undefined ? {} : { ruleVersion: state.manifest.derived.ruleVersion }) },
      codex: (state.manifest.codex ?? []).map((entry) => projectEntry(entry, hidden, descriptionIds)),
      ...(state.manifest.filters === undefined ? {} : { filters: state.manifest.filters.map(() => ({ id: '', name: '', criteria: {}, createdAt: '', updatedAt: '' })) }),
      ...(state.manifest.goals === undefined ? {} : { goals: state.manifest.goals.map(() => ({ id: '', nodeId: '', metric: 'words' as const, comparator: 'at-least' as const, target: 0, createdAt: '', updatedAt: '' })) }),
    },
    documents,
    revisionFloors: new Map(),
    declinedCodexFiles: new Set(),
    declinedDocFiles: new Set(),
    declinedText: new Map(),
    skills: new Map(),
    removedSkillFiles: new Set(),
    agentFiles: projectAgentFiles(state),
    removedAgentFiles: new Set(),
  };
}

function serializeLayerBudgets(budgets: Readonly<Partial<Record<LayerId, number>>>): Partial<Record<LayerId, number>> {
  const result: Partial<Record<LayerId, number>> = {};
  for (const id of LAYER_IDS) if (budgets[id] !== undefined) result[id] = budgets[id];
  return result;
}

function serializeResponseFormat(format: NonNullable<ContextConfig['responseFormat']>): NonNullable<ContextConfig['responseFormat']> {
  return format === 'text' ? 'text' : { jsonSchemaHint: format.jsonSchemaHint };
}

export function serializeContextConfig(config: ContextConfig, turns: readonly RecentTurn[] | undefined): SerializedContextConfig {
  const formatTime = config.formatTime ?? utcClock;
  const restoredTimes: Record<string, string> = {};
  for (const turn of turns ?? []) if (turn.restoredAt !== undefined) restoredTimes[String(turn.restoredAt)] = formatTime(turn.restoredAt);
  return {
    ...(config.contextBudget === undefined ? {} : { contextBudget: config.contextBudget }),
    ...(config.layerBudgets === undefined ? {} : { layerBudgets: serializeLayerBudgets(config.layerBudgets) }),
    ...(config.continuationChars === undefined ? {} : { continuationChars: config.continuationChars }),
    ...(config.focusFlowUp === undefined ? {} : { focusFlowUp: config.focusFlowUp }),
    ...(config.responseFormat === undefined ? {} : { responseFormat: serializeResponseFormat(config.responseFormat) }),
    ...(config.model === undefined ? {} : { model: serializeModel(config.model) }),
    restoredTimes,
  };
}

function serializeModel(model: ModelLimits): ModelLimits {
  return {
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.pricePer1k === undefined ? {} : { pricePer1k: { prompt: model.pricePer1k.prompt, completion: model.pricePer1k.completion } }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    ...(model.thinkingTokens === undefined ? {} : { thinkingTokens: model.thinkingTokens }),
    ...(model.cache === undefined ? {} : { cache: { readMultiplier: model.cache.readMultiplier, ...(model.cache.writeMultiplier === undefined ? {} : { writeMultiplier: model.cache.writeMultiplier }), ...(model.cache.minTokens === undefined ? {} : { minTokens: model.cache.minTokens }) } }),
  };
}

export function deserializeContextConfig(serialized: SerializedContextConfig): ContextConfig {
  const { restoredTimes, ...rest } = serialized;
  return { ...rest, formatTime: (epochMs: number) => restoredTimes[String(epochMs)] ?? utcClock(epochMs) };
}

function projectInstructions(instructions: NonNullable<AppSnapshot['instructions']>): NonNullable<AppSnapshot['instructions']> {
  return { source: instructions.source, text: instructions.text };
}

function projectOverrides(overrides: ContextOverrides): ContextOverrides {
  return {
    ...(overrides.include === undefined ? {} : { include: overrides.include.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
    ...(overrides.exclude === undefined ? {} : { exclude: overrides.exclude.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
  };
}

function projectTask(task: AgentTask): AgentTask {
  return {
    ...(task.conversation === undefined ? {} : { conversation: task.conversation }),
    ...(task.overrides === undefined ? {} : { overrides: projectOverrides(task.overrides) }),
    tool: task.tool,
    instruction: task.instruction,
    ...(task.params === undefined ? {} : { params: task.params }),
    ...(task.focus === undefined ? {} : { focus: task.focus }),
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    ...(task.selection === undefined ? {} : { selection: { from: task.selection.from, to: task.selection.to, exact: task.selection.exact } }),
    ...(task.scope === undefined ? {} : { scope: [...task.scope] }),
    ...(task.includeForwardOutline === undefined ? {} : { includeForwardOutline: task.includeForwardOutline }),
    ...(task.compact === undefined ? {} : { compact: task.compact }),
  };
}

export function projectContextInput(task: AgentTask, app: AppSnapshot, config: ContextConfig): ProjectedContextInput {
  const hidden = app.withheld ?? new Set<string>();
  const readPolicy = withheldReadPolicy(app);

  const allTurns = app.turns ?? [];
  const readable = allTurns.filter((turn) => turn.hidden !== true && turn.rewound !== true);
  const keepTurns = app.sessionKeepTurns ?? TURN_LIMIT;
  const summary = app.sessionSummary;
  const summaryBlocked = summary !== undefined && readPolicy !== undefined && !memoryReadable(summary, readPolicy);
  const covered = summary === undefined || summaryBlocked ? undefined : summaryPrefix(summary, allTurns);
  const invalidSummary = summary !== undefined && !summaryBlocked && covered === undefined;
  const tail = summary === undefined || summaryBlocked || invalidSummary ? readable : readable.slice(covered?.length ?? 0);
  const recentIds = new Set(tail.slice(-keepTurns).map((turn) => turn.turnId));
  const blockedIds = new Set(readable.filter((turn) => readPolicy !== undefined && !memoryReadable(turn, readPolicy)).map((turn) => turn.turnId));

  const turns = app.turns === undefined ? undefined : readable.map((turn) => {
    if (!recentIds.has(turn.turnId)) return { turnId: turn.turnId, intent: '', ...(turn.readPolicy === undefined ? {} : { readPolicy: turn.readPolicy }) };
    return blockedIds.has(turn.turnId) ? scrubbedTurn(turn) : projectTurn(turn);
  });
  const activity = app.activity === undefined ? undefined : app.activity
    .filter((row) => row.turnId !== undefined && recentIds.has(row.turnId))
    .map((row) => blockedIds.has(row.turnId as string) ? scrubbedRow(row) : projectActivity(hidden.size === 0 ? row : scrubbed(row, hidden)));
  const sessionSummary = summary === undefined ? undefined : projectSummary(summary, summaryBlocked || invalidSummary ? '' : summary.text);

  const projectedApp: AppSnapshot = {
    state: projectState(task, app.state, hidden),
    ...(app.tools === undefined ? {} : { tools: app.tools.map((tool) => ({ name: tool.name, signature: tool.signature })) }),
    ...(app.session === undefined ? {} : { session: { todayWords: app.session.todayWords, ...(app.session.target === undefined ? {} : { target: app.session.target }) } }),
    ...(turns === undefined ? {} : { turns }),
    ...(sessionSummary === undefined ? {} : { sessionSummary }),
    ...(app.sessionKeepTurns === undefined ? {} : { sessionKeepTurns: app.sessionKeepTurns }),
    ...(app.readPolicy === undefined ? {} : { readPolicy: app.readPolicy }),
    ...(activity === undefined ? {} : { activity }),
    ...(hidden.size === 0 ? {} : { withheld: hidden }),
    ...(app.instructions === undefined ? {} : { instructions: projectInstructions(app.instructions) }),
    ...(app.memoryIndex === undefined ? {} : { memoryIndex: app.memoryIndex }),
    ...(app.nonce === undefined ? {} : { nonce: app.nonce }),
  };
  return { task: projectTask(task), app: projectedApp, config: serializeContextConfig(config, turns) };
}
