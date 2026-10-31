/**
 * Speaker resolution — [av-script.md §2](../../../docs/architecture/av-script.md), on the pattern of the dialogue
 * package's `resolveSpeakerName` (`packages/dialogue/src/speakers.ts`), which this package does not import (SD3: the
 * patterns are reused, not the Ink machinery).
 *
 * A label resolves against the codex's characters by name or alias, through the canonical form the mention detector
 * uses, so a speaker and a mention in the manuscript agree on who is meant. An entry with `caseSensitive` set matches
 * exactly. Other entry types never speak.
 */

import { canonical, caseFold } from '@caotang/codex';
import type { CodexEntry } from '@caotang/store';

export type ScriptSpeakerResolution =
  | { readonly kind: 'resolved'; readonly entry: CodexEntry }
  | { readonly kind: 'ambiguous'; readonly entries: readonly CodexEntry[] }
  | { readonly kind: 'unknown' };

function keyOf(text: string, caseSensitive: boolean): string {
  const trimmed = canonical(text.trim());
  return caseSensitive ? trimmed : caseFold(trimmed);
}

function matches(entry: CodexEntry, name: string): boolean {
  return [entry.name, ...entry.aliases].some((term) => keyOf(term, entry.caseSensitive) === keyOf(name, entry.caseSensitive));
}

/** Resolves a speaker label against the codex's characters. */
export function resolveScriptSpeaker(entries: readonly CodexEntry[], name: string): ScriptSpeakerResolution {
  const found = entries.filter((entry) => entry.type === 'character' && matches(entry, name));
  if (found.length === 1 && found[0] !== undefined) return { kind: 'resolved', entry: found[0] };
  if (found.length > 1) return { kind: 'ambiguous', entries: found };
  return { kind: 'unknown' };
}
