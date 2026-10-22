/**
 * The coherence commands beyond the scene declarations and the finding status. `coherence.discardRun` — the run history's one removal ([coherence.md §7.1](../../../docs/architecture/coherence.md),
 * §8). Its rule is the lifecycle's (`discardRun` in the coherence module): the run goes, and so do the findings it
 * created that the writer or the agent never touched. The store's apply does the removal and keeps what it took, so
 * undo can put it back.
 *
 * Write-confirm for the agent, as the spec's table says: a discard is a writer's tidy-up of derived state, and an agent
 * never needs it to finish a task. The undo is compensable, because the removed run and findings are restored from a
 * copy taken at apply time, not by replaying a command.
 */

import type {
  CoherenceAddKnowledgeFactParams,
  CoherenceDiscardRunParams,
  CoherenceEditKnowledgeFactParams,
  CoherenceRemoveKnowledgeFactParams,
  CommandDescriptor,
  ValidationSnapshot,
} from './command.js';
import { knowledgeTextProblem } from './knowledge.js';
import { invalid, notFound, optionalNonBlankString, optionalNullableString, requireDeclaredParams, requireNonBlankString } from './params.js';
import { ok, type CommandError, type Result } from './result.js';

export const coherenceDiscardRun: CommandDescriptor<CoherenceDiscardRunParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.discardRun', params);
    if (!p.ok) return p;
    const runId = requireNonBlankString(p.value, 'runId');
    if (!runId.ok) return runId;
    const coherence = snapshot.coherence;
    if (coherence === undefined) {
      return notFound(
        'no coherence file is open for this project, so there is no run to discard',
        'open the project with its coherence file loaded: a project with no file loads as an empty one',
        'runId',
      );
    }
    if (!(coherence.runs ?? []).some((run) => run.id === runId.value)) {
      return notFound(`no run has id "${runId.value}"`, 'use a run from the run history in the findings tab', 'runId');
    }
    return ok({ runId: runId.value });
  },
};

/* ------------------------------------------------------------------ *
 * The knowledge facts (coherence.md §4.4, §7.1). The writer states a fact once and declares, scene by scene, who learns and
 * who knows it (`coherence.setSceneMeta`'s `learns_*` and `knows_*`). The three commands are write-confirm for the agent,
 * which holds no tool for the removal; each is undone by a restore taken at apply time.
 * ------------------------------------------------------------------ */

function openFile(snapshot: ValidationSnapshot, doing: string): Result<NonNullable<ValidationSnapshot['coherence']>, CommandError> {
  if (snapshot.coherence === undefined) {
    return notFound(
      `no coherence file is open for this project, so there is no knowledge to ${doing}`,
      'open the project with its coherence file loaded: a project with no file loads as an empty one',
    );
  }
  return ok(snapshot.coherence);
}

function textOf(params: Record<string, unknown>): Result<string, CommandError> {
  const text = requireNonBlankString(params, 'text');
  if (!text.ok) return text;
  const problem = knowledgeTextProblem(text.value);
  return problem === undefined ? ok(text.value.trim()) : invalid(problem, 'state the fact in one sentence', 'text');
}

function ruleLink(id: string, coherence: NonNullable<ValidationSnapshot['coherence']>): Result<string, CommandError> {
  const rules = coherence.worldRules ?? [];
  if (rules.some((rule) => rule.id === id)) return ok(id);
  const listed = rules.length === 0 ? 'the project has no world rule' : `valid world rules are ${rules.map((rule) => rule.id).join(', ')}`;
  return notFound(`ruleId "${id}" is not a world rule; ${listed}`, 'leave ruleId out, or pass a world rule', 'ruleId');
}

function entryLink(id: string, snapshot: ValidationSnapshot): Result<string, CommandError> {
  const entries = snapshot.manifest.codex ?? [];
  if (entries.some((entry) => entry.id === id)) return ok(id);
  const listed = entries.length === 0 ? 'the codex is empty' : `valid codex entries are ${entries.map((entry) => `${entry.name} (${entry.id})`).join(', ')}`;
  return notFound(`entryId "${id}" is not a codex entry; ${listed}`, 'leave entryId out, or pass a codex entry', 'entryId');
}

export const coherenceAddKnowledgeFact: CommandDescriptor<CoherenceAddKnowledgeFactParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.addKnowledgeFact', params);
    if (!p.ok) return p;
    const coherence = openFile(snapshot, 'add to');
    if (!coherence.ok) return coherence;
    const text = textOf(p.value);
    if (!text.ok) return text;
    const ruleId = optionalNonBlankString(p.value, 'ruleId');
    if (!ruleId.ok) return ruleId;
    const entryId = optionalNonBlankString(p.value, 'entryId');
    if (!entryId.ok) return entryId;
    if (ruleId.value !== undefined) {
      const linked = ruleLink(ruleId.value, coherence.value);
      if (!linked.ok) return linked;
    }
    if (entryId.value !== undefined) {
      const linked = entryLink(entryId.value, snapshot);
      if (!linked.ok) return linked;
    }
    return ok({
      text: text.value,
      ...(ruleId.value !== undefined ? { ruleId: ruleId.value } : {}),
      ...(entryId.value !== undefined ? { entryId: entryId.value } : {}),
    });
  },
};

function factOf(params: Record<string, unknown>, coherence: NonNullable<ValidationSnapshot['coherence']>): Result<string, CommandError> {
  const factId = requireNonBlankString(params, 'factId');
  if (!factId.ok) return factId;
  const facts = coherence.knowledge ?? [];
  if (facts.some((fact) => fact.id === factId.value)) return ok(factId.value);
  const listed = facts.length === 0 ? 'there is no knowledge fact' : `valid facts are ${facts.map((fact) => `"${fact.text}" (${fact.id})`).join(', ')}`;
  return notFound(`no knowledge fact has id "${factId.value}"; ${listed}`, 'use a fact from the Knowledge list', 'factId');
}

export const coherenceEditKnowledgeFact: CommandDescriptor<CoherenceEditKnowledgeFactParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.editKnowledgeFact', params);
    if (!p.ok) return p;
    const coherence = openFile(snapshot, 'edit');
    if (!coherence.ok) return coherence;
    const factId = factOf(p.value, coherence.value);
    if (!factId.ok) return factId;
    if (p.value['text'] === undefined && p.value['ruleId'] === undefined && p.value['entryId'] === undefined) {
      return invalid('coherence.editKnowledgeFact names nothing to change', 'pass text, ruleId or entryId (null clears a link)');
    }
    const out: CoherenceEditKnowledgeFactParams = { factId: factId.value };
    if (p.value['text'] !== undefined) {
      const text = textOf(p.value);
      if (!text.ok) return text;
      out.text = text.value;
    }
    for (const key of ['ruleId', 'entryId'] as const) {
      const value = optionalNullableString(p.value, key);
      if (!value.ok) return value;
      if (value.value === undefined) continue;
      if (value.value === null) {
        out[key] = null;
        continue;
      }
      if (value.value.trim() === '') return invalid(`params.${key} must not be blank`, `pass ${key} as an id, or null to clear the link`, key);
      const linked = key === 'ruleId' ? ruleLink(value.value, coherence.value) : entryLink(value.value, snapshot);
      if (!linked.ok) return linked;
      out[key] = value.value;
    }
    return ok(out);
  },
};

export const coherenceRemoveKnowledgeFact: CommandDescriptor<CoherenceRemoveKnowledgeFactParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('coherence.removeKnowledgeFact', params);
    if (!p.ok) return p;
    const coherence = openFile(snapshot, 'remove');
    if (!coherence.ok) return coherence;
    const factId = factOf(p.value, coherence.value);
    if (!factId.ok) return factId;
    return ok({ factId: factId.value });
  },
};
