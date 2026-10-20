/**
 * The tool-call wire protocol — the model's side of agent-harness.md §2.
 *
 * The loop speaks it one of two ways, picked per planner call by what the gateway's
 * `modelCaps` reports for the request's profile and model:
 *
 * - **JSON mode** (the fallback): no `tools` are declared; `responseFormat` carries
 *   `REPLY_SCHEMA_HINT`, and the reply is one JSON object in the content, parsed by
 *   `parseReply`. It is either `{"steps": [{"tool", "params", "expect"}, ...]}` — tool
 *   calls, in order, checked against the plan schema — or `{"reply": "..."}`, an answer.
 * - **Native mode**: the request declares `tools` (`plannerToolDefs`) and the reply's
 *   terminal `toolCalls` are the plan's steps; the reply's text is the card's rationale,
 *   and each call is answered by a `tool`-role message keyed by its id. The corrective
 *   and refusal texts the model reads are the same ones JSON mode sends, as user messages.
 *
 * In both modes the model never writes generated prose or a synopsis into a step: those are
 * proposals the loop stages, and the card shows them before anything is applied.
 */

import { err, ok, type CommandError, type Result } from '@caotang/bus';
import type { ToolDef } from '@caotang/gateway';
import { EXCERPT_CHARS, type ExternalToolDescriptor } from '@caotang/mcp-client';

import { checkParams } from '../validate.js';
import { planParams, type AskBack, type Plan, type PlanPreflight } from '../plan.js';
import type { ToolListing } from '../runtime.js';
import { isRecord } from '../util.js';

/** The first words of the planner's system message. The demo mock scripts match on it (gateway mock). */
export const PLANNER_SYSTEM_PREFIX = "You are Caotang's agent.";
/** The first words of a drafting call's system message: prose, synopses or findings for one tool. */
export const DRAFT_SYSTEM_PREFIX = 'You are drafting prose for Caotang.';

/** The shape of a reply, as the gateway's schema hint states it. Derived from the plan schema for the steps. */
export const REPLY_SCHEMA_HINT = {
  title: 'Caotang agent reply',
  description: 'Exactly one JSON object: either a list of tool steps, or a plain answer.',
  oneOf: [
    {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['tool', 'params', 'expect'],
            properties: {
              tool: { type: 'string', description: 'The tool, by name.' },
              params: { type: 'object', description: 'The tool params, as its schema states them.' },
              expect: { type: 'string', description: 'The effect the step should have, in words.' },
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['reply'],
      properties: { reply: { type: 'string', description: 'The answer, with no tool call.' } },
    },
  ],
} as const;

export type Reply = { readonly kind: 'reply'; readonly text: string } | { readonly kind: 'steps'; readonly plan: Plan };

/** Removes a Markdown code fence some models wrap their JSON in. Anything else is left as it is. */
function unfence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

const SHAPE_HINT =
  'Reply with exactly one JSON object and nothing else: {"steps": [{"tool": "<name>", "params": {...}, "expect": "<effect>"}]} to call tools, or {"reply": "<text>"} to answer.';

/**
 * A reply, parsed and checked against the plan schema. A malformed reply comes back as the words the
 * model should read next, because the loop sends them back as a message rather than failing the turn.
 */
export function parseReply(content: string): Result<Reply, string> {
  let value: unknown;
  try {
    value = JSON.parse(unfence(content));
  } catch {
    return err(`Your reply was not valid JSON. ${SHAPE_HINT}`);
  }
  if (!isRecord(value)) return err(`Your reply was not a JSON object. ${SHAPE_HINT}`);

  if (value['steps'] !== undefined) {
    const checked = checkParams('agent.plan', planParams, { steps: value['steps'] });
    if (!checked.ok) {
      const hint = checked.error.correctiveHint === undefined ? '' : ` ${checked.error.correctiveHint}`;
      return err(`Your steps were refused: ${checked.error.message}.${hint}`);
    }
    return ok({ kind: 'steps', plan: checked.value as unknown as Plan });
  }
  if (typeof value['reply'] === 'string') {
    if (value['reply'].trim() === '') return err(`Your reply was blank. ${SHAPE_HINT}`);
    return ok({ kind: 'reply', text: value['reply'] });
  }
  return err(`Your reply had neither "steps" nor "reply". ${SHAPE_HINT}`);
}

/**
 * The planner's callable surface this turn: the tools the model may call — callable and wired, with
 * the superseded read hidden once the review is wired (see `plannerSystem`). The system message and
 * the native tool declarations are both built from this one set, so the two can never disagree about
 * what is offered.
 */
export function plannerTools(tools: readonly ToolListing[]): readonly ToolListing[] {
  // continuity.scan is superseded by the coherence review once the review is wired (agent-harness §3, tool 10's note): the review
  // writes its findings to the inbox, where continuity.scan's stay in the transcript. The tool stays callable for older turns.
  const reviewWired = tools.some((tool) => tool.name === 'coherence.review' && tool.callable && tool.wired);
  return tools.filter((tool) => tool.callable && tool.wired && !(reviewWired && tool.name === 'continuity.scan'));
}

/**
 * An external tool's description as it reaches the model in the planner prompt or the native tools
 * declaration. The full text remains in the approval card (extensibility §4 rule 5); the excerpt
 * shrinks the ambient poisoning surface to the budget the spec sets for the model-facing side
 * (extensibility §4 rule 4).
 */
function clipExternalDescription(description: string): string {
  // The same rule as `tool.search`'s excerpt (mcp-client `clipChars`): at most EXCERPT_CHARS UTF-16
  // units including the ellipsis, cut on a code-point boundary, so the model reads the same excerpt
  // before and after a tool is loaded and never a lone surrogate.
  if (description.length <= EXCERPT_CHARS) return description;
  let out = '';
  for (const point of description) {
    if (out.length + point.length > EXCERPT_CHARS - 1) break;
    out += point;
  }
  return `${out}…`;
}

/**
 * The tools a native-mode request declares: the planner's callable set, then the external tools the
 * turn has loaded. A native tool goes by its registry name, an external one by the qualified name
 * `tool.search` returned; a native tool's description is Caotang's own text (in full) and an
 * external tool's is clipped to the spec's excerpt budget so the model's ambient context stays
 * bounded. The list is built fresh for each request, so a tool a mid-turn search loaded joins the
 * next request.
 */
export function plannerToolDefs(tools: readonly ToolListing[], externals: readonly ExternalToolDescriptor[]): ToolDef[] {
  return [
    ...plannerTools(tools).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema })),
    ...externals.map((tool) => ({ name: tool.qualifiedName, description: clipExternalDescription(tool.description), parameters: tool.inputSchema })),
  ];
}

const JSON_WIRE_RULES = [
  '- Put every read and every write for this turn into one "steps" list, in the order they should run.',
  '- read tools run at once and their results come back to you in the next message.',
  '- write-confirm tools are shown to the user for approval before they run. Do not ask for approval in text.',
  '- A step that is refused comes back with the reason. Correct it and reply again.',
] as const;

const NATIVE_WIRE_RULES = [
  '- Make every read call and every write call for this turn in one reply, in the order they should run.',
  '- read tools run at once and their results come back to you in the next message.',
  '- write-confirm tools are shown to the user for approval before they run. Do not ask for approval in text.',
  '- A call that is refused comes back with the reason. Correct it and call again.',
] as const;

function plannerPrompt(tools: readonly ToolListing[], loaded: string | undefined, wire: { readonly hint?: string; readonly rules: readonly string[] }): string {
  const lines = plannerTools(tools).map(
    (tool) => `- ${tool.name} [${tool.risk}] — ${tool.description}\n  params: ${JSON.stringify(tool.schema)}`,
  );
  return [
    `${PLANNER_SYSTEM_PREFIX} You act on the user's project only through the tools below.`,
    '',
    ...(wire.hint === undefined ? [] : [wire.hint, '']),
    'Rules:',
    ...wire.rules,
    '',
    'Tools:',
    ...lines,
    // The external tools loaded for this turn (extensibility §5), by name, as the one-line addendum (context-assembly §2).
    // Their descriptors reach the planner after the search that loaded them, in `loadedToolsMessage`, because the planner
    // request is built once per turn and a search runs within it.
    ...(loaded === undefined ? [] : ['', loaded]),
  ].join('\n');
}

/**
 * The planner's system message: the protocol, and the tools that can be called in this build, each
 * with its risk, its description and its schema. Built from the registry, so a tool the registry does
 * not list cannot be offered to the model.
 */
export function plannerSystem(tools: readonly ToolListing[], loaded?: string): string {
  return plannerPrompt(tools, loaded, { hint: SHAPE_HINT, rules: JSON_WIRE_RULES });
}

/**
 * The planner's system message when the request declares its tools natively: the same tools, and the
 * same rules worded for calls instead of the JSON envelope — there is no reply shape to state,
 * because the calls themselves are the reply.
 */
export function plannerSystemNative(tools: readonly ToolListing[], loaded?: string): string {
  return plannerPrompt(tools, loaded, { rules: NATIVE_WIRE_RULES });
}

/**
 * The external tools a search loaded this turn, as the model reads them (extensibility §5): each tool's qualified name,
 * its risk, its description as the spec's model-facing excerpt (rule 4), and its input schema. The full description still
 * reaches the writer on the approval card (rule 5); here the model only sees the excerpt so the ambient poisoning surface
 * stays bounded. A read runs at once; a write asks the writer on a one-step confirm card of its own, per call.
 */
export function loadedToolsMessage(tools: readonly ExternalToolDescriptor[]): string {
  return [
    'External tools loaded for this turn. Call a read by its qualified name, with params that match its schema. A write asks the writer to confirm each call before it runs.',
    ...tools.map((tool) => `- ${tool.qualifiedName} [${tool.effectiveRisk === 'read-auto' ? 'read' : 'write'}] — ${clipExternalDescription(tool.description)}\n  params: ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
}

/** A message that carries the results of the read steps that just ran. */
export function resultsMessage(results: readonly { readonly tool: string; readonly ok: boolean; readonly body: unknown }[]): string {
  return [
    'Tool results:',
    ...results.map((result) => `${JSON.stringify({ tool: result.tool, ok: result.ok, ...(result.ok ? { data: result.body } : { error: result.body }) })}`),
  ].join('\n');
}

/** A message that says which steps were refused before anything ran, and why. */
export function refusedStepsMessage(preflight: PlanPreflight): string {
  const refused = preflight.steps.filter((step) => step.status === 'refused');
  return [
    'These steps were refused before anything ran, so nothing was written:',
    ...refused.map((step) => `- step ${step.index + 1} (${step.tool}): ${refusalSentence(step.error?.message ?? 'refused', step.error?.correctiveHint)}`),
    'Reply with the corrected steps.',
  ].join('\n');
}

/** Text as the start of a sentence: an opening plain word is capitalised, and one that is a name (a tool, a parameter) is left as written. */
function sentenceOf(text: string): string {
  const opening = text.split(' ')[0] ?? '';
  return /^[a-z]/.test(text) && !opening.includes('.') && !opening.includes('_') ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/**
 * A refusal's message and its corrective hint as the words a writer or a model reads: the message ends with a full stop, and the hint
 * follows as a sentence of its own. Each opens as a sentence does, capitalised when it starts with a plain word and left as written
 * when it starts with a name.
 */
export function refusalSentence(message: string, hint: string | undefined): string {
  const text = sentenceOf(message.trim());
  const next = hint?.trim() ?? '';
  if (next === '') return text;
  const ended = /[.!?]$/.test(text) ? text : `${text}.`;
  return `${ended} ${sentenceOf(next)}`;
}

/**
 * The verify ladder's retry message (agent-harness §7): the failed step, and the ask-back payload
 * verbatim, which is also what the user is shown. One format serves the model and the card. The last
 * line names the correction in the wire's own words: a corrected step in the JSON envelope, or one
 * corrected call when the turn speaks native tool calls.
 */
export function retryMessage(index: number, tool: string, askBack: AskBack, native = false): string {
  return [
    `Step ${index + 1} (${tool}) did not apply, so nothing it would have written was written. The ask-back is:`,
    JSON.stringify(askBack),
    native ? `Reply with one corrected call for ${tool} and nothing else.` : `Reply with {"steps": [one corrected step for ${tool}]} and nothing else.`,
  ].join('\n');
}

/** A command error as the writer reads it on the card, and as the model reads it, for a refusal that came from a step's own gate. */
export function errorSummary(error: CommandError): string {
  return refusalSentence(error.message, error.correctiveHint);
}
