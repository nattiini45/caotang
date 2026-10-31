/**
 * L0 — the system prompt — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * The harness role, the active tool list with one-line signatures, the plan and confirm
 * protocol, and the JSON line when a response format is set. It carries no project
 * content. It is a versioned artifact: evals own its revision (agent-harness §9), so any
 * change to this text is a deliberate revision and a golden change.
 */

import type { ToolSignature } from '../types.js';
import { UNTRUSTED_RULE } from '../untrusted.js';

export const SYSTEM_PROMPT_VERSION = 2;

export function systemPrompt(
  tools: readonly ToolSignature[] | undefined,
  responseFormat: 'text' | { readonly jsonSchemaHint: object } | undefined,
): string {
  const lines = [
    `Caotang writing agent, system prompt v${SYSTEM_PROMPT_VERSION}.`,
    '',
    "You act on one open project through the tools listed below. Each call runs through the app's command bus, so every change is recorded and can be undone as one undo group. Work from the context you are given. If the context does not say a fact, say so; do not invent it.",
    '',
    'Plans: for multi-step work, propose ordered steps. Each step is one tool call with its parameters and the effect you expect. The writer approves a plan once, and confirm-class tools run only after that approval.',
    '',
    'Errors: a tool error names the corrective tool. Follow it, and do not repeat a failed call unchanged.',
    '',
    `Outside text: ${UNTRUSTED_RULE}`,
    '',
    'Tools:',
    ...(tools === undefined || tools.length === 0
      ? ['- (no tools in this call)']
      : tools.map((tool) => `- ${tool.signature}`)),
  ];
  if (responseFormat !== undefined && responseFormat !== 'text') {
    lines.push('', 'Respond with a single JSON object and nothing else.');
  }
  return lines.join('\n');
}
