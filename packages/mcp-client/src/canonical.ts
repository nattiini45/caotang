/**
 * Canonical JSON and the SHA-256 pins built on it — [extensibility.md §3.2](../../../docs/architecture/extensibility.md)
 * (`ToolPin`): the hash is SHA-256 over the canonical JSON of
 * `{ toolName, description, inputSchema }`.
 *
 * Canonical means one byte string per JSON value: object keys sorted by UTF-16 code
 * unit, no insignificant whitespace, arrays in order, `undefined` members dropped. A pin
 * is only as stable as this function, so the test suite pins its output byte for byte.
 *
 * `crypto.subtle` is used rather than `node:crypto`, because the client also runs in the
 * browser build and must not import a Node module.
 */

import { canonicalJson } from '@caotang/ids';

/** The canonical text itself lives in `@caotang/ids`, shared with the skill pins; it is re-exported so this package's callers keep one import. */
export { canonicalJson };

/** SHA-256 of a string, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The self-declared hints a pin covers. `readOnlyHint` decides whether a trusted tool runs without a
 * confirmation (§7), so a hint that changed without a review would promote a write tool to auto-run.
 * They are pinned with the rest of the listing, and only the four hint keys, never anything else.
 */
export interface PinnedAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * The pin hash of one advertised tool: SHA-256 over the canonical JSON of
 * `{ toolName, description, inputSchema }`, extended with the four hint keys when the server
 * advertises them (see {@link PinnedAnnotations}). A tool with no hints hashes exactly as the base rule says.
 *
 * The description and the schema are the server's own text, taken verbatim. The caller normalises an
 * absent description to `''` and an absent schema to `{ type: 'object' }` before it reaches here, so the
 * same listing always hashes the same way.
 */
export function pinHash(tool: {
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: PinnedAnnotations;
}): Promise<string> {
  const annotations = tool.annotations === undefined ? undefined : pinnedHints(tool.annotations);
  return sha256Hex(canonicalJson({ toolName: tool.toolName, description: tool.description, inputSchema: tool.inputSchema, annotations }));
}

/** The four hint keys that are present, with their values. Absent when none is. */
export function pinnedHints(annotations: PinnedAnnotations): PinnedAnnotations | undefined {
  const hints: Record<string, boolean> = {};
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    const value = annotations[key];
    if (typeof value === 'boolean') hints[key] = value;
  }
  return Object.keys(hints).length === 0 ? undefined : (hints as PinnedAnnotations);
}

/** One prompt argument as a pin covers it. */
export interface PinnedPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/**
 * What a pin covers, by kind (extensibility §3.2). A tool keeps the rule above, byte for byte. A prompt is pinned over its
 * name, description and arguments, and a resource template over its URI template, description and MIME type: the text a
 * server writes about them reaches the writer and, for a prompt, the model. Each kind has its own namespace in the hash
 * (`kind` is part of the canonical text), and its own map in the settings, so adding a kind changed no tool hash.
 */
export type PinSubject =
  | { readonly kind: 'tool'; readonly toolName: string; readonly description?: string; readonly inputSchema?: unknown; readonly annotations?: PinnedAnnotations }
  | { readonly kind: 'prompt'; readonly name: string; readonly description?: string; readonly arguments?: readonly PinnedPromptArgument[] }
  | { readonly kind: 'resourceTemplate'; readonly uriTemplate: string; readonly description?: string; readonly mimeType?: string };

/** The pin hash of one subject. A tool hashes exactly as {@link pinHash} says. */
export function subjectHash(subject: PinSubject): Promise<string> {
  switch (subject.kind) {
    case 'tool':
      return pinHash({
        toolName: subject.toolName,
        description: subject.description ?? '',
        inputSchema: subject.inputSchema ?? { type: 'object' },
        ...(subject.annotations === undefined ? {} : { annotations: subject.annotations }),
      });
    case 'prompt':
      return sha256Hex(
        canonicalJson({
          kind: 'prompt',
          name: subject.name,
          description: subject.description ?? '',
          arguments: (subject.arguments ?? []).map((argument) => ({ name: argument.name, description: argument.description ?? '', required: argument.required === true })),
        }),
      );
    case 'resourceTemplate':
      return sha256Hex(canonicalJson({ kind: 'resourceTemplate', uriTemplate: subject.uriTemplate, description: subject.description ?? '', mimeType: subject.mimeType }));
  }
}
