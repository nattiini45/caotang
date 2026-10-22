/**
 * `coherence.json` text ⇄ {@link CoherenceFile} — [coherence.md §3](../../../docs/architecture/coherence.md)
 * with the project-format §2/§6 tolerance rules applied per item.
 *
 * Tolerance, in three tiers:
 *  - **Whole file.** Text that is not JSON, or has no usable `formatVersion`, is
 *    `corrupt` and the caller runs the recovery posture (file.ts). A file from a
 *    newer format is `newer` and is never overwritten.
 *  - **Per item.** A finding, run, rule or declaration that fails its field
 *    contract is dropped and named in a notice. One bad item never blocks the load.
 *  - **Per field.** An unknown timeline mode reads as `linear` (§5.2.1). An
 *    unknown top-level key is dropped on the next save, with a notice (§6).
 */

import { isCoherenceId } from './ids.js';
import {
  COHERENCE_FORMAT_VERSION,
  DETERMINISTIC_CHECK_IDS,
  EVIDENCE_QUOTE_LIMIT,
  FINDING_CLASSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  KNOWLEDGE_TEXT_LIMIT,
  LLM_CATEGORIES,
  NOTE_LIMIT,
  RUN_KINDS,
  RUN_STATUSES,
  TIMELINE_MODES,
  WORLD_RULE_ORIGINS,
  WORLD_RULE_TEXT_LIMIT,
  emptyCoherenceFile,
  type CoherenceFile,
  type CoherenceRun,
  type Evidence,
  type Finding,
  type KnowledgeFact,
  type KnowledgeLink,
  type ModelMeta,
  type Redetection,
  type ReviewStateEntry,
  type SceneMeta,
  type SceneThread,
  type TimelineMode,
  type WorldRule,
} from './model.js';
import { codePointLength } from './text.js';

export type LoadNoticeCode =
  | 'unknown-field'
  | 'unknown-timeline-mode'
  | 'dropped-finding'
  | 'dropped-run'
  | 'dropped-scene-meta'
  | 'dropped-world-rule'
  | 'dropped-knowledge'
  | 'dropped-review-state'
  | 'dangling-scene-meta'
  | 'dangling-finding'
  | 'dangling-world-rule-source'
  | 'dangling-knowledge'
  | 'world-rule-source-changed'
  | 'corrupt-file'
  | 'restored-from-snapshot'
  | 'newer-format';

/** One line for the load report. Plain language: it is shown to the writer. */
export interface LoadNotice {
  readonly code: LoadNoticeCode;
  readonly message: string;
}

export type ParseOutcome =
  | { readonly kind: 'ok'; readonly file: CoherenceFile; readonly notices: LoadNotice[] }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'newer'; readonly formatVersion: number };

type Obj = Record<string, unknown>;

const FINDING_KEYS = [
  'id', 'runId', 'class', 'checkId', 'type', 'severity', 'status', 'factGroup', 'message', 'expected',
  'evidence', 'reasoning', 'modelMeta', 'createdAt', 'updatedAt', 'dismissedReason', 'note', 'supersededBy',
  'redetections', 'createdByRunId', 'touchedAt',
] as const;
const RUN_KEYS = [
  'id', 'at', 'kind', 'checkIds', 'scope', 'findingsUpserted', 'tokens', 'model', 'status', 'notes',
] as const;
const SCENE_META_KEYS = ['pov', 'dayOffset', 'durationDays', 'after', 'expectedPresent', 'timelineMode', 'threads', 'learns', 'knows'] as const;
const KNOWLEDGE_LINK_KEYS = ['entryId', 'factId'] as const;
const KNOWLEDGE_KEYS = ['id', 'text', 'ruleId', 'entryId', 'createdAt', 'updatedAt'] as const;
const THREAD_KEYS = ['id', 'payoff', 'note'] as const;
const WORLD_RULE_KEYS = ['id', 'text', 'origin', 'source', 'verified', 'createdAt', 'updatedAt'] as const;
const TOP_KEYS = ['formatVersion', 'findings', 'runs', 'sceneMeta', 'worldRules', 'knowledge', 'reviewState'] as const;

function isRecord(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function unknownKeys(obj: Obj, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

/** A `reason` string on failure, the value on success. Kept as a union so callers can say why. */
type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
const good = <T>(value: T): Read<T> => ({ ok: true, value });
const bad = <T>(reason: string): Read<T> => ({ ok: false, reason });

export function readEvidence(raw: unknown): Read<Evidence> {
  if (!isRecord(raw)) return bad('evidence is not an object');
  if (!isNonEmptyString(raw.docId)) return bad('evidence.docId is empty');
  if (typeof raw.quote !== 'string' || codePointLength(raw.quote) > EVIDENCE_QUOTE_LIMIT) {
    return bad(`evidence.quote is not a string of at most ${EVIDENCE_QUOTE_LIMIT} characters`);
  }
  if (!isNonNegInt(raw.from) || !isNonNegInt(raw.to) || raw.from > raw.to) {
    return bad('evidence offsets are not ordered non-negative integers');
  }
  const evidence: Evidence = { docId: raw.docId, quote: raw.quote, from: raw.from, to: raw.to };
  if (raw.paraHash !== undefined) {
    if (typeof raw.paraHash !== 'string') return bad('evidence.paraHash is not a string');
    evidence.paraHash = raw.paraHash;
  }
  return good(evidence);
}

function readEvidenceList(raw: unknown, max: number): Read<Evidence[]> {
  if (!Array.isArray(raw)) return bad('evidence is not a list');
  if (raw.length > max) return bad(`evidence has ${raw.length} passages; at most ${max} are allowed`);
  const out: Evidence[] = [];
  for (const item of raw) {
    const read = readEvidence(item);
    if (!read.ok) return bad(read.reason);
    out.push(read.value);
  }
  return good(out);
}

function readRedetections(raw: unknown): Read<Redetection[] | undefined> {
  if (raw === undefined) return good(undefined);
  if (!Array.isArray(raw)) return bad('redetections is not a list');
  const out: Redetection[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isCoherenceId('r', item.runId) || !isIso(item.at)) {
      return bad('a redetection has no valid runId or time');
    }
    const evidence = readEvidenceList(item.evidence, 2);
    if (!evidence.ok) return bad(evidence.reason);
    out.push({ runId: item.runId, at: item.at, evidence: evidence.value });
  }
  return good(out);
}

function readModelMeta(raw: unknown): Read<ModelMeta | undefined> {
  if (raw === undefined) return good(undefined);
  if (!isRecord(raw) || typeof raw.model !== 'string' || !isNonNegInt(raw.promptTokens) || !isNonNegInt(raw.completionTokens)) {
    return bad('modelMeta is malformed');
  }
  return good({ model: raw.model, promptTokens: raw.promptTokens, completionTokens: raw.completionTokens });
}

/** Checks a finding's identity fields against §5.1 / §5.3, which name the only legal check ids. */
function checkIdFits(cls: string, checkId: string): boolean {
  if (cls === 'deterministic') return (DETERMINISTIC_CHECK_IDS as readonly string[]).includes(checkId);
  if (cls === 'llm') {
    return checkId.startsWith('llm:') && (LLM_CATEGORIES as readonly string[]).includes(checkId.slice(4));
  }
  return false;
}

export function readFinding(raw: unknown): Read<Finding> {
  if (!isRecord(raw)) return bad('finding is not an object');
  if (!isCoherenceId('f', raw.id)) return bad('finding.id is not an f_ id');
  if (!isCoherenceId('r', raw.runId)) return bad('finding.runId is not an r_ id');
  if (!(FINDING_CLASSES as readonly unknown[]).includes(raw.class)) return bad('finding.class is not a known class');
  if (typeof raw.checkId !== 'string' || !checkIdFits(raw.class as string, raw.checkId)) {
    return bad(`finding.checkId "${String(raw.checkId)}" is not a check of class ${String(raw.class)}`);
  }
  if (!isNonEmptyString(raw.type)) return bad('finding.type is empty');
  if (!(FINDING_SEVERITIES as readonly unknown[]).includes(raw.severity)) return bad('finding.severity is not known');
  if (!(FINDING_STATUSES as readonly unknown[]).includes(raw.status)) return bad('finding.status is not known');
  if (!isNonEmptyString(raw.factGroup)) return bad('finding.factGroup is empty');
  if (typeof raw.message !== 'string') return bad('finding.message is not a string');
  if (raw.expected !== undefined && typeof raw.expected !== 'string') return bad('finding.expected is not a string');
  const evidence = readEvidenceList(raw.evidence, 2);
  if (!evidence.ok) return bad(evidence.reason);
  // §3: an llm finding carries exactly two passages (the verdict's pair). Codex-level and deterministic ones may carry fewer.
  if (raw.class === 'llm' && evidence.value.length !== 2) return bad('an llm finding must carry exactly two passages');
  if (raw.reasoning !== undefined && typeof raw.reasoning !== 'string') return bad('finding.reasoning is not a string');
  const modelMeta = readModelMeta(raw.modelMeta);
  if (!modelMeta.ok) return bad(modelMeta.reason);
  if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) return bad('finding timestamps are not ISO-8601');
  if (raw.status === 'dismissed' && !isNonEmptyString(raw.dismissedReason)) {
    return bad('a dismissed finding has no dismissedReason');
  }
  if (raw.dismissedReason !== undefined && typeof raw.dismissedReason !== 'string') return bad('dismissedReason is not a string');
  if (raw.note !== undefined && (typeof raw.note !== 'string' || codePointLength(raw.note) > NOTE_LIMIT)) {
    return bad('finding.note is malformed');
  }
  if (raw.supersededBy !== undefined && typeof raw.supersededBy !== 'string') return bad('supersededBy is not a string');
  const redetections = readRedetections(raw.redetections);
  if (!redetections.ok) return bad(redetections.reason);
  if (raw.createdByRunId !== undefined && !isCoherenceId('r', raw.createdByRunId)) return bad('finding.createdByRunId is not an r_ id');
  if (raw.touchedAt !== undefined && !isIso(raw.touchedAt)) return bad('finding.touchedAt is not ISO-8601');

  const finding: Finding = {
    id: raw.id,
    runId: raw.runId,
    class: raw.class as Finding['class'],
    checkId: raw.checkId,
    type: raw.type,
    severity: raw.severity as Finding['severity'],
    status: raw.status as Finding['status'],
    factGroup: raw.factGroup,
    message: raw.message,
    evidence: evidence.value,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
  if (raw.expected !== undefined) finding.expected = raw.expected as string;
  if (raw.reasoning !== undefined) finding.reasoning = raw.reasoning as string;
  if (modelMeta.value !== undefined) finding.modelMeta = modelMeta.value;
  if (raw.dismissedReason !== undefined) finding.dismissedReason = raw.dismissedReason as string;
  if (raw.note !== undefined) finding.note = raw.note as string;
  if (raw.supersededBy !== undefined) finding.supersededBy = raw.supersededBy as string;
  if (redetections.value !== undefined) finding.redetections = redetections.value;
  if (raw.createdByRunId !== undefined) finding.createdByRunId = raw.createdByRunId as string;
  if (raw.touchedAt !== undefined) finding.touchedAt = raw.touchedAt as string;
  return good(finding);
}

/** The scopes a run can record (coherence.md §6.2): one document, what changed, the whole manuscript. */
const SCOPE_MODES: readonly string[] = ['doc', 'changed', 'full'];

export function readRun(raw: unknown): Read<CoherenceRun> {
  if (!isRecord(raw)) return bad('run is not an object');
  if (!isCoherenceId('r', raw.id)) return bad('run.id is not an r_ id');
  if (!isIso(raw.at)) return bad('run.at is not an ISO-8601 time');
  if (!(RUN_KINDS as readonly unknown[]).includes(raw.kind)) return bad('run.kind is not known');
  if (!isStringArray(raw.checkIds)) return bad('run.checkIds is not a list of strings');
  if (!isRecord(raw.scope) || !isStringArray(raw.scope.docIds)) return bad('run.scope.docIds is not a list of strings');
  if (!isStringArray(raw.findingsUpserted)) return bad('run.findingsUpserted is not a list of strings');
  if (!(RUN_STATUSES as readonly unknown[]).includes(raw.status)) return bad('run.status is not known');
  let tokens: CoherenceRun['tokens'];
  if (raw.tokens !== undefined) {
    if (!isRecord(raw.tokens) || !isNonNegInt(raw.tokens.promptTokens) || !isNonNegInt(raw.tokens.completionTokens)) {
      return bad('run.tokens is malformed');
    }
    tokens = { promptTokens: raw.tokens.promptTokens, completionTokens: raw.tokens.completionTokens };
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') return bad('run.model is not a string');
  if (raw.notes !== undefined && !isStringArray(raw.notes)) return bad('run.notes is not a list of strings');

  const run: CoherenceRun = {
    id: raw.id,
    at: raw.at,
    kind: raw.kind as CoherenceRun['kind'],
    checkIds: raw.checkIds,
    // The mode is read when it is one of the three scopes, and left out otherwise: an unknown mode is not a reason to drop the run.
    scope: { docIds: raw.scope.docIds, ...(SCOPE_MODES.includes(raw.scope['mode'] as string) ? { mode: raw.scope['mode'] as 'doc' | 'changed' | 'full' } : {}) },
    findingsUpserted: raw.findingsUpserted,
    status: raw.status as CoherenceRun['status'],
  };
  if (tokens !== undefined) run.tokens = tokens;
  if (raw.model !== undefined) run.model = raw.model as string;
  if (raw.notes !== undefined) run.notes = raw.notes as string[];
  return good(run);
}

export function readWorldRule(raw: unknown): Read<WorldRule> {
  if (!isRecord(raw)) return bad('world rule is not an object');
  if (!isCoherenceId('w', raw.id)) return bad('worldRule.id is not a w_ id');
  if (typeof raw.text !== 'string' || raw.text.trim() === '' || codePointLength(raw.text) > WORLD_RULE_TEXT_LIMIT) {
    return bad(`worldRule.text is empty or longer than ${WORLD_RULE_TEXT_LIMIT} characters`);
  }
  if (!(WORLD_RULE_ORIGINS as readonly unknown[]).includes(raw.origin)) return bad('worldRule.origin is not known');
  if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) return bad('worldRule timestamps are not ISO-8601');
  const rule: WorldRule = {
    id: raw.id,
    text: raw.text,
    origin: raw.origin as WorldRule['origin'],
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
  if (raw.source !== undefined) {
    const source = readEvidence(raw.source);
    if (!source.ok) return bad(source.reason);
    rule.source = source.value;
  }
  if (raw.verified !== undefined) {
    if (typeof raw.verified !== 'boolean') return bad('worldRule.verified is not a boolean');
    rule.verified = raw.verified;
  }
  return good(rule);
}

/** §4.4: a fact is a `k_` id, one sentence within the limit, and two optional links. */
export function readKnowledgeFact(raw: unknown): Read<KnowledgeFact> {
  if (!isRecord(raw)) return bad('knowledge fact is not an object');
  if (!isCoherenceId('k', raw.id)) return bad('knowledge.id is not a k_ id');
  if (typeof raw.text !== 'string' || raw.text.trim() === '' || codePointLength(raw.text) > KNOWLEDGE_TEXT_LIMIT) {
    return bad(`knowledge.text is empty or longer than ${KNOWLEDGE_TEXT_LIMIT} characters`);
  }
  if (raw.ruleId !== undefined && !isNonEmptyString(raw.ruleId)) return bad('knowledge.ruleId is not a string');
  if (raw.entryId !== undefined && !isNonEmptyString(raw.entryId)) return bad('knowledge.entryId is not a string');
  if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) return bad('knowledge timestamps are not ISO-8601');
  const fact: KnowledgeFact = { id: raw.id, text: raw.text, createdAt: raw.createdAt as string, updatedAt: raw.updatedAt as string };
  if (raw.ruleId !== undefined) fact.ruleId = raw.ruleId as string;
  if (raw.entryId !== undefined) fact.entryId = raw.entryId as string;
  return good(fact);
}

export function readReviewState(raw: unknown): Read<ReviewStateEntry> {
  if (!isRecord(raw) || !isNonNegInt(raw.lastReviewedRevision) || !isIso(raw.lastReviewedAt)) {
    return bad('review state is malformed');
  }
  return good({ lastReviewedRevision: raw.lastReviewedRevision, lastReviewedAt: raw.lastReviewedAt });
}

/**
 * Reads one scene declaration. Notices are collected rather than returned as a
 * failure, because a declaration with one bad field keeps its good fields: the
 * writer loses the bad one, and the report says which.
 */
export function readSceneMeta(raw: unknown, notices: LoadNotice[], key: string, modes: Set<string>): SceneMeta | undefined {
  if (!isRecord(raw)) {
    notices.push({ code: 'dropped-scene-meta', message: `The scene declarations for "${key}" are not an object and were dropped.` });
    return undefined;
  }
  const meta: SceneMeta = {};
  const dropped = (field: string): void => {
    notices.push({ code: 'dropped-scene-meta', message: `The "${field}" declaration for "${key}" is malformed and was dropped.` });
  };
  for (const extra of unknownKeys(raw, SCENE_META_KEYS)) {
    notices.push({ code: 'unknown-field', message: `Scene declarations for "${key}" have a field this version does not know ("${extra}"); it is dropped on the next save.` });
  }
  if (raw.pov !== undefined) {
    if (isNonEmptyString(raw.pov)) meta.pov = raw.pov;
    else dropped('pov');
  }
  if (raw.dayOffset !== undefined) {
    if (isNonNegInt(raw.dayOffset)) meta.dayOffset = raw.dayOffset;
    else dropped('dayOffset');
  }
  if (raw.durationDays !== undefined) {
    if (isNonNegInt(raw.durationDays)) meta.durationDays = raw.durationDays;
    else dropped('durationDays');
  }
  if (raw.after !== undefined) {
    if (isStringArray(raw.after)) meta.after = [...new Set(raw.after)];
    else dropped('after');
  }
  if (raw.expectedPresent !== undefined) {
    if (isStringArray(raw.expectedPresent)) meta.expectedPresent = [...new Set(raw.expectedPresent)];
    else dropped('expectedPresent');
  }
  if (raw.timelineMode !== undefined) {
    const mode = raw.timelineMode;
    if (typeof mode === 'string' && (TIMELINE_MODES as readonly string[]).includes(mode)) {
      if (mode !== 'linear') meta.timelineMode = mode as TimelineMode;
    } else {
      modes.add(String(mode));
    }
  }
  if (raw.threads !== undefined) {
    if (Array.isArray(raw.threads)) {
      const threads = readThreads(raw.threads, notices, key);
      if (threads.length > 0) meta.threads = threads;
    } else dropped('threads');
  }
  for (const field of ['learns', 'knows'] as const) {
    if (raw[field] === undefined) continue;
    if (Array.isArray(raw[field])) {
      const links = readKnowledgeLinks(raw[field], notices, key, field);
      if (links.length > 0) meta[field] = links;
    } else dropped(field);
  }
  return meta;
}

/** Reads §4.4's pairs. An entry that is not a pair of strings, or repeats one, is dropped with a notice; the rest are kept. */
function readKnowledgeLinks(raw: readonly unknown[], notices: LoadNotice[], key: string, field: 'learns' | 'knows'): KnowledgeLink[] {
  const links: KnowledgeLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || !isNonEmptyString(item.entryId) || !isNonEmptyString(item.factId)) {
      notices.push({ code: 'dropped-scene-meta', message: `An entry of "${field}" declared on "${key}" is malformed and was dropped.` });
      continue;
    }
    const pair = JSON.stringify([item.entryId, item.factId]);
    if (seen.has(pair)) {
      notices.push({ code: 'dropped-scene-meta', message: `"${field}" on "${key}" names the same character and fact twice; the second was dropped.` });
      continue;
    }
    for (const extra of unknownKeys(item, KNOWLEDGE_LINK_KEYS)) {
      notices.push({ code: 'unknown-field', message: `An entry of "${field}" on "${key}" has a field this version does not know ("${extra}"); it is dropped on the next save.` });
    }
    seen.add(pair);
    links.push({ entryId: item.entryId, factId: item.factId });
  }
  return links;
}

/**
 * Reads §5.5's threads. An entry that is not a thread, or repeats a handle (compared without case, as the fact group is),
 * is dropped with a notice and the rest are kept. An unknown field on an entry is reported, as on the scene itself.
 */
function readThreads(raw: readonly unknown[], notices: LoadNotice[], key: string): SceneThread[] {
  const threads = new Map<string, SceneThread>();
  for (const item of raw) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.payoff) || (item.note !== undefined && typeof item.note !== 'string')) {
      notices.push({ code: 'dropped-scene-meta', message: `A thread declared on "${key}" is malformed and was dropped.` });
      continue;
    }
    const id = item.id.trim();
    const handle = id.toLowerCase();
    if (threads.has(handle)) {
      notices.push({ code: 'dropped-scene-meta', message: `The thread "${id}" is declared twice on "${key}"; the second was dropped.` });
      continue;
    }
    for (const extra of unknownKeys(item, THREAD_KEYS)) {
      notices.push({ code: 'unknown-field', message: `A thread on "${key}" has a field this version does not know ("${extra}"); it is dropped on the next save.` });
    }
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    threads.set(handle, note === '' ? { id, payoff: item.payoff } : { id, payoff: item.payoff, note });
  }
  return [...threads.values()];
}

/** Serializes in §3's field order, with keys sorted where the spec leaves order to the map. */
export function serializeCoherenceFile(file: CoherenceFile): string {
  const ordered = {
    formatVersion: COHERENCE_FORMAT_VERSION,
    findings: file.findings.map(orderFinding),
    runs: file.runs.map(orderRun),
    sceneMeta: sortedMap(file.sceneMeta, orderSceneMeta),
    worldRules: file.worldRules.map(orderWorldRule),
    // Not written when empty, so a build that predates the key sees no unknown field in a file that holds no fact (§4.4).
    ...(file.knowledge.length > 0 ? { knowledge: file.knowledge.map(orderKnowledge) } : {}),
    reviewState: sortedMap(file.reviewState, (state) => ({
      lastReviewedRevision: state.lastReviewedRevision,
      lastReviewedAt: state.lastReviewedAt,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function sortedMap<T>(map: Record<string, T>, order: (value: T) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) out[key] = order(value);
  }
  return out;
}

function pick(source: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function orderFinding(finding: Finding): Obj {
  return pick(finding as unknown as Obj, FINDING_KEYS);
}

function orderRun(run: CoherenceRun): Obj {
  return pick(run as unknown as Obj, RUN_KEYS);
}

function orderKnowledge(fact: KnowledgeFact): Obj {
  return pick(fact as unknown as Obj, KNOWLEDGE_KEYS);
}

function orderSceneMeta(meta: SceneMeta): Obj {
  return pick(meta as unknown as Obj, SCENE_META_KEYS);
}

function orderWorldRule(rule: WorldRule): Obj {
  return pick(rule as unknown as Obj, WORLD_RULE_KEYS);
}

/**
 * Parses coherence.json text. Never throws: every failure is an outcome, so the
 * caller decides between recovery and read-only without a try/catch of its own.
 */
export function parseCoherenceFile(text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { kind: 'corrupt', reason: `not JSON (${(cause as Error).message})` };
  }
  if (!isRecord(raw)) return { kind: 'corrupt', reason: 'the top level is not an object' };
  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'corrupt', reason: 'formatVersion is missing or not a positive integer' };
  }
  if (version > COHERENCE_FORMAT_VERSION) return { kind: 'newer', formatVersion: version };
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.runs) || !Array.isArray(raw.worldRules)) {
    return { kind: 'corrupt', reason: 'findings, runs or worldRules is not a list' };
  }
  if (!isRecord(raw.sceneMeta) || !isRecord(raw.reviewState)) {
    return { kind: 'corrupt', reason: 'sceneMeta or reviewState is not an object' };
  }

  const notices: LoadNotice[] = [];
  for (const key of unknownKeys(raw, TOP_KEYS)) {
    notices.push({ code: 'unknown-field', message: `coherence.json has a field this version does not know ("${key}"); it is dropped on the next save.` });
  }

  const file = emptyCoherenceFile();
  const seen = new Set<string>();
  for (const item of raw.findings) {
    const read = readFinding(item);
    if (!read.ok) {
      notices.push({ code: 'dropped-finding', message: `A finding in coherence.json could not be read (${read.reason}) and was dropped.` });
    } else if (seen.has(read.value.id)) {
      notices.push({ code: 'dropped-finding', message: `Finding ${read.value.id} appears twice in coherence.json; the second copy was dropped.` });
    } else {
      seen.add(read.value.id);
      file.findings.push(read.value);
    }
  }
  for (const item of raw.runs) {
    const read = readRun(item);
    if (read.ok) file.runs.push(read.value);
    else notices.push({ code: 'dropped-run', message: `A run in coherence.json could not be read (${read.reason}) and was dropped.` });
  }
  const modes = new Set<string>();
  for (const key of Object.keys(raw.sceneMeta).sort()) {
    const meta = readSceneMeta(raw.sceneMeta[key], notices, key, modes);
    if (meta !== undefined) file.sceneMeta[key] = meta;
  }
  if (modes.size > 0) {
    notices.push({
      code: 'unknown-timeline-mode',
      message: `Unknown timeline mode${modes.size > 1 ? 's' : ''} ${[...modes].map((m) => `"${m}"`).join(', ')} read as linear. The mode list is closed; a new mode needs a spec change.`,
    });
  }
  for (const item of raw.worldRules) {
    const read = readWorldRule(item);
    if (read.ok) file.worldRules.push(read.value);
    else notices.push({ code: 'dropped-world-rule', message: `A world rule could not be read (${read.reason}) and was dropped.` });
  }
  if (raw.knowledge !== undefined && !Array.isArray(raw.knowledge)) {
    notices.push({ code: 'dropped-knowledge', message: 'The knowledge list in coherence.json is not a list and was dropped.' });
  }
  const factIds = new Set<string>();
  for (const item of Array.isArray(raw.knowledge) ? raw.knowledge : []) {
    const read = readKnowledgeFact(item);
    const label = isRecord(item) && typeof item.text === 'string' && item.text.trim() !== '' ? `"${item.text.trim().slice(0, 60)}"` : 'one';
    if (!read.ok) notices.push({ code: 'dropped-knowledge', message: `A knowledge fact (${label}) could not be read (${read.reason}) and was dropped.` });
    else if (factIds.has(read.value.id)) notices.push({ code: 'dropped-knowledge', message: `The knowledge fact "${read.value.text.slice(0, 60)}" appears twice in coherence.json; the second copy was dropped.` });
    else {
      factIds.add(read.value.id);
      file.knowledge.push(read.value);
    }
  }
  for (const key of Object.keys(raw.reviewState).sort()) {
    const read = readReviewState(raw.reviewState[key]);
    if (read.ok) file.reviewState[key] = read.value;
    else notices.push({ code: 'dropped-review-state', message: `The review state for "${key}" is malformed and was dropped.` });
  }
  return { kind: 'ok', file, notices };
}
