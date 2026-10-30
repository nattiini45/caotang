/**
 * The Context section's prompt preview (ui-modules §5.2, context-assembly §5): the prompt a scene draft of the open document would
 * send, under the budgets the writer has typed, shown the way the plan card shows a step's prompt. Pure over the project and the
 * budgets, so the section can show what the next draft would send without a model call.
 */

import { scenePromptPreview, type ContextConfig, type PromptPreview } from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

import { contextConfigOf, type ContextSettings } from './settings.js';

/** The brief a sample draft is previewed with. The writer's own brief is not known until a draft is asked for. */
export const SAMPLE_BRIEF = 'Continue the scene from where it stops.';

/** What the section shows: the prompt, or the sentence that says why there is none. */
export type ContextPreviewView = { readonly kind: 'prompt'; readonly preview: PromptPreview } | { readonly kind: 'none'; readonly message: string };

/**
 * The preview of a scene draft of `docId` under `budgets`. `docId` is the open document. With no document open, or one the agent
 * does not draft a scene of, the view says so in words rather than showing a prompt for something else. `model` is the limits of
 * the model the active Chat role runs on, so the preview carries its window warning and its cost as the plan card does.
 */
export function contextPreviewOf(state: ProjectState, docId: string | null | undefined, budgets: ContextSettings, model?: ContextConfig['model']): ContextPreviewView {
  if (docId === undefined || docId === null) {
    return { kind: 'none', message: 'Open a scene to see the prompt the agent would send for it.' };
  }
  const preview = scenePromptPreview(state, docId, { mode: 'continue', instruction: SAMPLE_BRIEF, config: { ...contextConfigOf(budgets), ...(model === undefined ? {} : { model }) } });
  if (preview === undefined) {
    return { kind: 'none', message: 'The open document is not a scene the agent drafts. Open a scene to see the prompt it would send.' };
  }
  return { kind: 'prompt', preview };
}
