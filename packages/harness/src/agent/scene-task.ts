/**
 * The task texts the loop gives `scene.draft` and `continuity.scan` (context-assembly §2), in a module of their own with no
 * dependencies beyond types. The Settings preview (step-preview.ts) and the brief tools build the same tasks, and importing them
 * from here keeps the agent loop out of the app's first load (it loads with the lazy harness).
 */

import type { AgentTask, SelectionSpan } from '@caotang/context';

import { isRecord } from '../util.js';

/**
 * A selection the editor captured, read from a step's params: its body offsets and the text found there.
 * `undefined` for anything that is not one, so a rewrite with no usable selection is assembled without one.
 */
export function spanOf(value: unknown): SelectionSpan | undefined {
  if (!isRecord(value)) return undefined;
  const { from, to, exact } = value;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof exact !== 'string') return undefined;
  return { from, to, exact };
}

/**
 * scene.draft's task (context-assembly §2): the brief and the document it is for. For a rewrite, the
 * selection is what the focus layer quotes, so the model reads the text it is asked to replace.
 */
export function sceneTask(
  title: string,
  docId: string,
  mode: 'draft' | 'continue' | 'rewrite_selection',
  instruction: string,
  selection: SelectionSpan | undefined,
  targetWords: number | undefined,
  forwardOutline: boolean,
): AgentTask {
  return {
    tool: 'scene.draft',
    instruction: `Document "${title}":\nMode: ${mode}\nBrief: ${instruction}`,
    params: { mode, ...(targetWords === undefined ? {} : { target_words: targetWords }) },
    focus: docId,
    mode,
    // The per-call opt-in (context-assembly §4): off unless the step asked for it, so a later scene's synopsis is withheld by default.
    includeForwardOutline: forwardOutline,
    ...(mode === 'rewrite_selection' && selection !== undefined ? { selection } : {}),
  };
}

/** continuity.scan's task (context-assembly §2): the documents to check, and the aspects asked for, if any. */
export function continuityTask(scope: readonly string[], aspects: readonly string[]): AgentTask {
  return {
    tool: 'continuity.scan',
    instruction:
      aspects.length === 0
        ? 'Check these documents for continuity problems.'
        : `Check these documents for continuity problems in these aspects: ${aspects.join(', ')}.`,
    params: { aspects },
    scope,
  };
}
