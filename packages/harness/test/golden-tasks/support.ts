/** Fixtures the golden tasks share: codex entries, and the synthetic harbour-town text the drafts and checks read. */

import type { CodexEntry, ProjectState } from '@caotang/store';

import { makeState } from '../fixtures.js';

export function codexEntry(partial: Partial<CodexEntry> & Pick<CodexEntry, 'id' | 'name' | 'type' | 'description'>): CodexEntry {
  return {
    aliases: [],
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    ...partial,
  } as CodexEntry;
}

/** The fixture project, with more codex entries added to it. */
export function withCodex(...entries: CodexEntry[]): () => ProjectState {
  return () => {
    const state = makeState();
    for (const item of entries) state.manifest.codex?.push(item);
    return state;
  };
}
