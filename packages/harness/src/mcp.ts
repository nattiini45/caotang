/**
 * The registry-to-MCP mapping — [extensibility.md §7](../../../docs/architecture/extensibility.md),
 * outward direction, as a pure function.
 *
 * The inward direction (a server's advertised tools into Caotang's `effectiveRisk`)
 * is the MCP client's, and it lands with v0.2. Nothing here reads a server.
 *
 * | Caotang `risk`             | annotations                                                                  |
 * |--------------------------|------------------------------------------------------------------------------|
 * | `read`                   | `readOnlyHint: true`, `destructiveHint: false`                               |
 * | `write-auto`             | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint` where the tool is idempotent by design |
 * | `write-confirm`          | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`     |
 * | hard-deny class (`never`)| **not exposed**                                                              |
 *
 * `agent.plan` is protocol, not a registry member, and is never exposed either way
 * (§7). A tool with no annotation equivalent carries its facts in the description
 * text, as §7 says: the response cap always, and "undo via Caotang's turn checkpoints"
 * where the tool is undoable.
 */

import type { ToolMetadata, ToolRisk } from './metadata.js';

/** The §7 table's rows: the registry's four risk values, with the hard-deny class named. */
export type ExposureRisk = ToolRisk | 'never';

export interface McpAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint?: boolean;
}

export type McpExposure =
  | { readonly exposed: true; readonly annotations: McpAnnotations; readonly description: string }
  | { readonly exposed: false; readonly reason: 'hard-deny' | 'protocol' };

export interface ExposureInput {
  readonly name: string;
  readonly risk: ExposureRisk;
  readonly undoable: boolean;
  readonly response_token_cap: number;
  readonly description: string;
}

/**
 * The tools §7 names as idempotent by design. `meta.set` is the only one in the
 * v0.1 table, and §3's row 5 says so ("Idempotent by design").
 */
const IDEMPOTENT_BY_DESIGN: ReadonlySet<string> = new Set(['meta.set']);

const CONFIRM_SENTENCE = 'Requires user confirmation.';
const AUTO_SENTENCE = 'Applies automatically within an approved turn.';
/**
 * What an external caller is told about a write-auto tool. An external caller has no
 * approved turn of its own, so the approval it runs under is the per-project opt-in
 * (extensibility §9), and the description says so rather than leaving §7's phrase alone.
 */
const EXTERNAL_WRITE_SENTENCE =
  'An external caller has no approved turn: the write runs only where the user has turned on external writes for this project.';

/**
 * The `_meta` key an external caller sends to make a retried write-auto call write once. A `_meta` key name is a reverse-DNS prefix, a
 * slash and a name, and this one is outside the reserved `io.modelcontextprotocol/*` space. It rides the request, not the tool's schema,
 * so the frozen v0.1 tool surface is unchanged, and the annotation stays `idempotentHint: false`: the tool is idempotent when the
 * caller sends a key, and an annotation describes the tool, not the call.
 */
export const IDEMPOTENCY_KEY_META = 'app.caotang/idempotencyKey';

const IDEMPOTENCY_SENTENCE = `To make a retry write once, send ${IDEMPOTENCY_KEY_META} in the request's _meta: a repeat with the same key and arguments gets the first answer, and the same key with other arguments is refused.`;

/** §7's annotation column for a risk class, or `undefined` for a class that is not exposed. */
export function annotationsFor(risk: ExposureRisk, name: string): McpAnnotations | undefined {
  switch (risk) {
    case 'read':
      return { readOnlyHint: true, destructiveHint: false };
    case 'write-auto':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: IDEMPOTENT_BY_DESIGN.has(name) };
    case 'write-confirm':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    case 'never':
    case 'meta':
      return undefined;
  }
}

/**
 * The description an external client reads. §7's prefixes and suffixes, plus the
 * two facts that have no annotation: the cap, and the undo.
 *
 * A write-confirm description **starts** with the confirmation sentence, every time
 * (§7). The metadata text may carry its own copy in the middle, so that copy is taken
 * out of the body before the sentence goes in front. Counting copies instead would
 * accept a description that starts with something else.
 */
export function describeForExposure(input: ExposureInput): string {
  const parts: string[] = [];
  let body = input.description.trim();
  if (input.risk === 'write-confirm') {
    body = body.split(CONFIRM_SENTENCE).join(' ').replace(/\s+/g, ' ').trim();
    parts.push(CONFIRM_SENTENCE);
  }
  if (body !== '') parts.push(body);
  if (input.risk === 'write-auto') {
    if (!body.includes(AUTO_SENTENCE)) parts.push(AUTO_SENTENCE);
    parts.push(EXTERNAL_WRITE_SENTENCE, IDEMPOTENCY_SENTENCE);
  }
  parts.push(`Returns at most ${input.response_token_cap} tokens.`);
  if (input.undoable) parts.push("Undo via Caotang's turn checkpoints.");
  return parts.join(' ');
}

/** The full outward mapping for one tool: exposed or not, and if so, its annotations and description. */
export function mcpExposure(input: ExposureInput | ToolMetadata): McpExposure {
  if (input.risk === 'meta') return { exposed: false, reason: 'protocol' };
  if (input.risk === 'never') return { exposed: false, reason: 'hard-deny' };
  const annotations = annotationsFor(input.risk, input.name);
  if (annotations === undefined) return { exposed: false, reason: 'protocol' };
  return { exposed: true, annotations, description: describeForExposure(input) };
}
