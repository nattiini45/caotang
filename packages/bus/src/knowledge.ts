/**
 * The knowledge-fact rules the bus and the store share — [coherence.md §4.4](../../../docs/architecture/coherence.md).
 *
 * The same reason as `coherence.ts`: the dependency runs coherence → store → bus, so the descriptors' validate and the
 * store's apply read one rule from here, and `@caotang/coherence`'s tests read the limit back against its own.
 */

/** §4.4 `KnowledgeFact.text`: one sentence, at most this many code points. */
export const KNOWLEDGE_TEXT_LIMIT = 300;

/** One knowledge fact as the store holds it. The coherence module's `KnowledgeFact` is this shape. */
export interface KnowledgeFactRecord {
  id: string;
  text: string;
  ruleId?: string;
  entryId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What is wrong with a fact's text, or `undefined` when it fits: not blank, and within the limit. */
export function knowledgeTextProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 'a knowledge fact needs some text';
  const length = [...trimmed].length;
  return length > KNOWLEDGE_TEXT_LIMIT ? `a knowledge fact is at most ${KNOWLEDGE_TEXT_LIMIT} characters; this one is ${length}` : undefined;
}
