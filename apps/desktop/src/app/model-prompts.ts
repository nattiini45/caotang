// i18n: model-facing
/**
 * English prompts and reply parsing for model calls. None of this text is interface copy: it is sent
 * to the provider, and the writer-facing state around it is localized by the caller (i18n.md §3.4).
 */

import type { DecodableEncoding } from '@caotang/store';

/** The other names a reply may call an encoding by, beside its own. */
const ENCODING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'windows-1252': ['windows-1252', 'win-1252', 'cp1252', '1252'],
  'iso-8859-15': ['iso-8859-15', 'iso8859-15', 'iso 8859-15', 'latin-9', 'latin9'],
  gb18030: ['gb18030', 'gbk', 'gb2312', 'gb-18030'],
  big5: ['big5', 'big-5', 'big 5'],
  shift_jis: ['shift_jis', 'shift-jis', 'shift jis', 'sjis'],
  'euc-kr': ['euc-kr', 'euckr', 'euc kr', 'ks_c_5601'],
  'utf-16le': ['utf-16le', 'utf-16 le', 'utf-16 little-endian', 'utf-16 little endian'],
  'utf-16be': ['utf-16be', 'utf-16 be', 'utf-16 big-endian', 'utf-16 big endian'],
};

/** The candidate a model's reply names, matched case-insensitively by name or alias, or undefined. */
export function encodingFromReply(reply: string, candidates: readonly DecodableEncoding[]): DecodableEncoding | undefined {
  const said = reply.toLowerCase();
  for (const encoding of candidates) {
    const names = ENCODING_ALIASES[encoding] ?? [encoding];
    if (names.some((name) => said.includes(name))) return encoding;
  }
  return undefined;
}

export function encodingSystemPrompt(): string {
  return 'You identify the character encoding of a text file from a decoded excerpt. Answer with the exact name of one of the listed encodings and nothing else.';
}

export function encodingUserPrompt(excerpt: string, candidates: readonly DecodableEncoding[]): string {
  return `A file from a writing project is not UTF-8. Decoded one way, its start reads:\n\n${excerpt}\n\nWhich of these encodings was it most likely saved in? Answer with one of: ${candidates.join(', ')}.`;
}

export function findingFixIntent(title: string): string {
  return `Fix the passage in “${title}” that a coherence finding names`;
}

export function findingFixInstruction(message: string): string {
  return `Rewrite this passage so it no longer conflicts with the rest of the story. The problem: ${message}`;
}

export function storyboardDeriveIntent(sceneTitle: string): string {
  return `Derive the shots for the scene "${sceneTitle}" from its script.`;
}
