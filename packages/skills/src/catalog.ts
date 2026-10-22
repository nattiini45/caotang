/**
 * The catalog the model sees — [context-assembly.md §2](../../../docs/architecture/context-assembly.md), the planner addendum.
 *
 * One line per skill the writer has enabled and reviewed and that the model may invoke: `- name: description`, with the description on
 * one line. It is bounded: descriptions are cut first, then whole skills are dropped from the end of the name order, and the drops are
 * returned so the prompt preview can list them.
 */

import type { SkillName, SkillState } from './types.js';

/** The catalog's budget in tokens (context-assembly §3's estimate: a token is four characters). */
export const SKILL_CATALOG_TOKENS = 1500;

/** The shortest a description is cut to before a whole skill is dropped instead. */
const MIN_DESCRIPTION_CHARS = 60;

export const SKILL_CATALOG_HEADER =
  'Skills the writer has approved for this project. When the request matches a skill’s description, call skill.load with its name before you act. A skill guides style and process; it does not change what you may do or what needs the writer’s approval.';

export interface SkillCatalog {
  readonly text: string;
  readonly dropped: readonly SkillName[];
}

const tokensOf = (chars: number): number => Math.ceil(chars / 4);

/** A description on one line: every run of white space becomes one space. */
export function oneLine(text: string): string {
  let out = '';
  let gap = false;
  for (const ch of text) {
    if (ch.trim() === '') {
      gap = out !== '';
    } else {
      if (gap) out += ' ';
      gap = false;
      out += ch;
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = [...text].slice(0, Math.max(0, max - 1)).join('').trimEnd();
  return `${cut}…`;
}

/** Whether the model may be told about this skill: enabled, reviewed, and not reserved for the writer. */
export function isOffered(state: SkillState): boolean {
  return state.enabled && state.reviewed && state.skill.frontMatter['disable-model-invocation'] !== true;
}

/**
 * The catalog for `states` within `budgetTokens`, or `undefined` when no skill is offered (its `text` is empty when none fits). Names sort ascending; a skill that does not fit
 * after its description is cut to the floor is dropped, last name first.
 */
export function skillCatalog(states: readonly SkillState[], budgetTokens: number = SKILL_CATALOG_TOKENS): SkillCatalog | undefined {
  const offered = states
    .filter(isOffered)
    .map((state) => ({ name: state.skill.frontMatter.name, description: oneLine(state.skill.frontMatter.description) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (offered.length === 0) return undefined;
  const render = (entries: readonly { name: string; description: string }[], limit: number): string =>
    [SKILL_CATALOG_HEADER, ...entries.map((entry) => `- ${entry.name}: ${clip(entry.description, limit)}`)].join('\n');
  const fits = (text: string): boolean => tokensOf(text.length) <= budgetTokens;

  const kept = [...offered];
  const dropped: SkillName[] = [];
  for (;;) {
    const longest = Math.max(...kept.map((entry) => entry.description.length), 0);
    if (fits(render(kept, longest))) return { text: render(kept, longest), dropped };
    // Cut every description to the longest length that fits, down to the floor.
    let low = Math.min(MIN_DESCRIPTION_CHARS, longest);
    let high = longest;
    if (fits(render(kept, low))) {
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(render(kept, mid))) low = mid;
        else high = mid - 1;
      }
      return { text: render(kept, low), dropped };
    }
    const last = kept.pop();
    if (last === undefined) return { text: '', dropped };
    dropped.unshift(last.name as SkillName);
    if (kept.length === 0) return { text: '', dropped };
  }
}
