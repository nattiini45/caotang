// i18n: package-refs
/**
 * Codex-level deterministic checks — [coherence.md §5.1](../../../../docs/architecture/coherence.md):
 * `codex.alias-collisions` and `codex.never-mentioned`.
 *
 * Neither quotes a manuscript passage, so neither carries evidence. Their subject
 * is the codex itself, and the identity of each finding lives in its factGroup.
 */

import type { CodexEntry } from '@caotang/store';

import { DETERMINISTIC_CHECK_LABELS } from '../model.js';
import { groupKey, labelOf, pairKey, termsOf, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

const UNMENTIONABLE_POLICIES = new Set<CodexEntry['includePolicy']>(['always', 'manual', 'never']);

function byId(a: CodexEntry, b: CodexEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * §5.1: any term of entry A equals any term of entry B, case-insensitively. An
 * alias equal to another entry's name is still a collision, because detection
 * can resolve it only one way and the writer should know which way.
 */
export function checkAliasCollisions(input: CheckInput): CheckOutput {
  const entries = [...input.entries].sort(byId);
  const drafts: DraftFinding[] = [];
  const termMaps = entries.map((entry) => {
    const map = new Map<string, string>();
    for (const term of termsOf(entry)) {
      const key = term.toLowerCase();
      if (!map.has(key)) map.set(key, term);
    }
    return map;
  });

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const termsA = termMaps[i];
      const termsB = termMaps[j];
      if (a === undefined || b === undefined || termsA === undefined || termsB === undefined) continue;
      for (const [key, surface] of termsA) {
        if (!termsB.has(key)) continue;
        drafts.push({
          checkId: 'codex.alias-collisions',
          type: 'alias-collision',
          severity: 'warning',
          factGroup: groupKey(pairKey(a.id, b.id), `alias:${key}`),
          evidence: [],
          message: `"${labelOf(a)}" and "${labelOf(b)}" both answer to "${surface}"`,
          messageRef: {
            id: 'coherence.codex.aliasCollision',
            message: '"{firstEntry}" and "{secondEntry}" both answer to "{name}"',
            values: { firstEntry: labelOf(a), secondEntry: labelOf(b), name: surface },
          },
          expected: 'each name and alias identifies one codex entry',
        });
      }
    }
  }
  return { drafts, notes: [] };
}

/**
 * §5.1: an entry with zero hits across every scanned document. `always`,
 * `manual` and `never` entries are exempt, because their presence in a context
 * does not depend on being mentioned. If any scanned document lacks a count, the
 * total is incomplete, so the check is skipped and the run says so.
 */
export function checkNeverMentioned(input: CheckInput): CheckOutput {
  // The Findings tab shows run notes as they are, so the check is named by its label, never by its id.
  const check = `“${DETERMINISTIC_CHECK_LABELS['codex.never-mentioned']}”`;
  if (input.scenes.length === 0) {
    return { drafts: [], notes: [`${check} not evaluated: no scanned documents`] };
  }
  const missing = input.scenes.filter((scene) => !input.hits.has(scene.docId));
  if (missing.length > 0) {
    return {
      drafts: [],
      notes: [`${check} not evaluated: mention counts are unavailable for ${missing.length} scanned document(s)`],
    };
  }
  const drafts: DraftFinding[] = [];
  for (const entry of [...input.entries].sort(byId)) {
    if (UNMENTIONABLE_POLICIES.has(entry.includePolicy)) continue;
    let total = 0;
    for (const scene of input.scenes) total += input.hits.get(scene.docId)?.get(entry.id) ?? 0;
    if (total > 0) continue;
    drafts.push({
      checkId: 'codex.never-mentioned',
      type: 'never-mentioned',
      severity: 'info',
      factGroup: groupKey(entry.id, 'never-mentioned'),
      evidence: [],
      message: `"${labelOf(entry)}" is never named in the scanned manuscript`,
      messageRef: {
        id: 'coherence.codex.neverMentioned',
        message: '"{entry}" is never named in the scanned manuscript',
        values: { entry: labelOf(entry) },
      },
      expected: 'check its spelling and aliases, or set its policy to manual or never',
    });
  }
  return { drafts, notes: [] };
}
