/**
 * The store's applies for `coherence.discardRun` and the knowledge facts — [coherence.md §4.4, §7.1 and §8](../../../docs/architecture/coherence.md).
 *
 * The removal is the run history's, and the rule about which findings it takes is the bus's (`findingsDiscardedWith`),
 * the same one the coherence module's lifecycle applies. The apply changes the held copy of the file; the file is saved
 * through `ArtifactFs` by the coherence module after the command, as every other coherence change is (coherence-state.ts).
 *
 * Undo is `compensable`, and it puts back what the discard took and nothing else. The run goes back at the index it held,
 * and each finding goes back at the index it held. Everything else the file holds at undo time is left as it is. A scan or
 * a model review between the discard and the undo is a later change of its own, and its run and findings stay. A finding
 * is not put back where the file already holds the same fact (the check, the group and the documents, which is the key
 * the coherence module's upsert matches on): the scan that ran after the discard shows that fact, and putting the old
 * finding back beside it would show the fact twice, and a dismissal of the held one would be undone by its duplicate.
 */

import {
  findingsDiscardedWith,
  isEmptySceneMeta,
  type ApplyContext,
  type CommandApply,
  type CoherenceAddKnowledgeFactParams,
  type CoherenceDiscardRunParams,
  type CoherenceEditKnowledgeFactParams,
  type CoherenceRemoveKnowledgeFactParams,
  type KnowledgeFactRecord,
  type KnowledgeLinkRecord,
} from '@caotang/bus';
import { newId } from '@caotang/ids';

import type { CoherenceFindingState, CoherenceRunState, CoherenceState } from './coherence-state.js';
import { runWordsOf } from './coherence-words.js';
import type { ProjectState } from './state.js';

/** The held file a discard changes. `validate` refused a project with none, so a missing one here is a defect. */
function heldFile(state: ProjectState): CoherenceState {
  if (state.coherence === undefined) throw new Error('no coherence file is open for this project');
  return state.coherence;
}

/** A finding the discard took, with the index it held in the file, so undo can put it back there. */
interface TakenFinding {
  readonly finding: CoherenceFindingState;
  readonly index: number;
}

/**
 * The fact a finding is about, as the coherence module keys it (its upsert's identity): the check, the group and the
 * documents it quotes. A finding without a check or a group carries no such key, so nothing is taken to match it.
 */
function factKeyOf(finding: CoherenceFindingState): string | undefined {
  if (finding.checkId === undefined || finding.factGroup === undefined) return undefined;
  const docs = [...new Set((finding.evidence ?? []).map((passage) => passage.docId))].sort().join(',');
  return JSON.stringify([finding.checkId, finding.factGroup, docs]);
}

/**
 * Puts back what a discard took, in place, and nothing else. `taken` is in the order the file held the findings, so each
 * one is inserted at its own index in turn, and the indices still fit the file the earlier insertions built.
 */
function restoreTaken(file: CoherenceState, run: CoherenceRunState, runIndex: number, taken: readonly TakenFinding[]): void {
  if (!file.runs.some((candidate) => candidate.id === run.id)) {
    file.runs.splice(Math.min(runIndex, file.runs.length), 0, run);
  }
  for (const { finding, index } of taken) {
    if (file.findings.some((candidate) => candidate.id === finding.id)) continue;
    const key = factKeyOf(finding);
    if (key !== undefined && file.findings.some((candidate) => factKeyOf(candidate) === key)) continue;
    file.findings.splice(Math.min(index, file.findings.length), 0, finding);
  }
}

/** The discard, applied to the held file, with the compensation that restores exactly what it took. */
export const applyCoherenceDiscardRun: CommandApply<CoherenceDiscardRunParams, ProjectState> = (state, params, context: ApplyContext) => {
  const file = heldFile(state);
  const runIndex = file.runs.findIndex((candidate) => candidate.id === params.runId);
  const run: CoherenceRunState | undefined = file.runs[runIndex];
  if (run === undefined) {
    throw new Error(`coherence.discardRun reached its apply with run "${params.runId}", which validate refused`);
  }
  const { kept, removed } = findingsDiscardedWith(file.findings, params.runId);
  const taken: TakenFinding[] = removed.map((finding) => ({ finding, index: file.findings.indexOf(finding) }));

  file.runs = file.runs.filter((candidate) => candidate.id !== params.runId);
  file.findings = kept;

  context.undo.compensate(`restore run ${params.runId} and its findings`, () => {
    restoreTaken(heldFile(state), run, runIndex, taken);
  });
  const count = removed.length;
  const words = `discarded ${runWordsOf(run)}`;
  context.report({
    affected: [],
    summary: count === 0 ? words : `${words} and ${count} untouched finding${count === 1 ? '' : 's'} it made`,
  });
  return { runId: params.runId, removedFindingIds: removed.map((finding) => finding.id) };
};

/* ------------------------------------------------------------------ *
 * The knowledge facts (coherence.md §4.4, §7.1). Each apply changes the held file and registers one compensation, so one undo
 * restores one command: a removal puts back the fact and every `learns` and `knows` pair it took, in one step.
 * ------------------------------------------------------------------ */

type LinkField = 'learns' | 'knows';
const LINK_FIELDS: readonly LinkField[] = ['learns', 'knows'];

/** The pairs a removal took from one scene, so undo can put them back. */
interface TakenPairs {
  readonly docId: string;
  readonly learns: readonly KnowledgeLinkRecord[];
  readonly knows: readonly KnowledgeLinkRecord[];
}

/** Takes every pair that names `factId` out of the scenes, dropping a record the removal leaves empty. Returns what it took. */
function takePairs(file: CoherenceState, factId: string): TakenPairs[] {
  const taken: TakenPairs[] = [];
  for (const [docId, meta] of Object.entries(file.sceneMeta)) {
    const gone: Record<LinkField, KnowledgeLinkRecord[]> = { learns: [], knows: [] };
    for (const field of LINK_FIELDS) {
      const links = meta[field];
      if (links === undefined) continue;
      gone[field] = links.filter((link) => link.factId === factId);
      if (gone[field].length === 0) continue;
      const kept = links.filter((link) => link.factId !== factId);
      if (kept.length > 0) meta[field] = kept;
      else delete meta[field];
    }
    if (gone.learns.length === 0 && gone.knows.length === 0) continue;
    taken.push({ docId, learns: gone.learns, knows: gone.knows });
    if (isEmptySceneMeta(meta)) delete file.sceneMeta[docId];
  }
  return taken;
}

/** Puts taken pairs back on scenes that still exist, without doubling a pair a later edit already declared. */
function putPairsBack(file: CoherenceState, taken: readonly TakenPairs[], sceneExists: (docId: string) => boolean): void {
  for (const { docId, learns, knows } of taken) {
    if (!sceneExists(docId)) continue;
    const meta = file.sceneMeta[docId] ?? {};
    for (const [field, links] of [['learns', learns], ['knows', knows]] as const) {
      if (links.length === 0) continue;
      const held = meta[field] ?? [];
      const missing = links.filter((link) => !held.some((other) => other.entryId === link.entryId && other.factId === link.factId));
      if (missing.length > 0) meta[field] = [...held, ...missing];
    }
    file.sceneMeta[docId] = meta;
  }
}

function pairCount(taken: readonly TakenPairs[]): number {
  return taken.reduce((total, scene) => total + scene.learns.length + scene.knows.length, 0);
}

/** The shortest words for a fact in an activity row: its text, cut at 60 characters. */
function factWords(fact: Pick<KnowledgeFactRecord, 'text'>): string {
  const chars = [...fact.text];
  return `“${chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : fact.text}”`;
}

export function knowledgeApplies(clock: { now(): number }): {
  readonly add: CommandApply<CoherenceAddKnowledgeFactParams, ProjectState>;
  readonly edit: CommandApply<CoherenceEditKnowledgeFactParams, ProjectState>;
  readonly remove: CommandApply<CoherenceRemoveKnowledgeFactParams, ProjectState>;
} {
  const stamp = (): string => new Date(clock.now()).toISOString();

  const add: CommandApply<CoherenceAddKnowledgeFactParams, ProjectState> = (state, params, context) => {
    const file = heldFile(state);
    const id = newId('k', { taken: new Set(file.knowledge.map((fact) => fact.id)) });
    const at = stamp();
    const fact: KnowledgeFactRecord = {
      id,
      text: params.text,
      ...(params.ruleId !== undefined ? { ruleId: params.ruleId } : {}),
      ...(params.entryId !== undefined ? { entryId: params.entryId } : {}),
      createdAt: at,
      updatedAt: at,
    };
    file.knowledge.push(fact);
    context.undo.compensate(`remove the knowledge fact ${factWords(fact)}`, () => {
      const current = heldFile(state);
      current.knowledge = current.knowledge.filter((candidate) => candidate.id !== id);
      takePairs(current, id);
    });
    context.report({ affected: [], summary: `added the knowledge fact ${factWords(fact)}` });
    return { factId: id };
  };

  const edit: CommandApply<CoherenceEditKnowledgeFactParams, ProjectState> = (state, params, context) => {
    const file = heldFile(state);
    const fact = file.knowledge.find((candidate) => candidate.id === params.factId);
    if (fact === undefined) {
      throw new Error(`coherence.editKnowledgeFact reached its apply with fact "${params.factId}", which validate refused`);
    }
    const before = structuredClone(fact);
    if (params.text !== undefined) fact.text = params.text;
    for (const key of ['ruleId', 'entryId'] as const) {
      const value = params[key];
      if (value === undefined) continue;
      if (value === null) delete fact[key];
      else fact[key] = value;
    }
    fact.updatedAt = stamp();
    context.undo.compensate(`restore the knowledge fact ${factWords(before)}`, () => {
      const index = heldFile(state).knowledge.findIndex((candidate) => candidate.id === before.id);
      if (index >= 0) heldFile(state).knowledge[index] = before;
    });
    context.report({ affected: [], summary: `changed the knowledge fact ${factWords(fact)}` });
    return { factId: params.factId };
  };

  const remove: CommandApply<CoherenceRemoveKnowledgeFactParams, ProjectState> = (state, params, context) => {
    const file = heldFile(state);
    const index = file.knowledge.findIndex((candidate) => candidate.id === params.factId);
    const fact = file.knowledge[index];
    if (fact === undefined) {
      throw new Error(`coherence.removeKnowledgeFact reached its apply with fact "${params.factId}", which validate refused`);
    }
    file.knowledge = file.knowledge.filter((candidate) => candidate.id !== params.factId);
    const taken = takePairs(file, params.factId);
    context.undo.compensate(`restore the knowledge fact ${factWords(fact)} and its declarations`, () => {
      const current = heldFile(state);
      if (!current.knowledge.some((candidate) => candidate.id === fact.id)) {
        current.knowledge.splice(Math.min(index, current.knowledge.length), 0, fact);
      }
      putPairsBack(current, taken, (docId) => state.manifest.tree.some((node) => node.id === docId));
    });
    const count = pairCount(taken);
    context.report({
      affected: [],
      summary: `removed the knowledge fact ${factWords(fact)}${count === 0 ? '' : ` and ${count} declaration${count === 1 ? '' : 's'} of who learns or knows it`}`,
    });
    return { factId: params.factId, removedDeclarations: count };
  };

  return { add, edit, remove };
}
