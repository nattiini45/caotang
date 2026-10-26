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
import type { ToolCall as WireToolCall, ToolDef } from '@caotang/gateway';
import { clipChars, EXCERPT_CHARS, type ExternalToolDescriptor } from '@caotang/mcp-client';

import { checkParams } from '../validate.js';
import { PLAN_STEPS_MAX, planParams, type AskBack, type Plan, type PlanPreflight } from '../plan.js';
import type { CallParams } from '../types.js';
import type { ToolListing } from '../runtime.js';
import { isRecord } from '../util.js';

/** The first words of the planner's system message. The demo mock scripts match on it (gateway mock). */
export const PLANNER_SYSTEM_PREFIX = "You are Caotang's agent.";
/** The first words of a drafting call's system message: prose, synopses or findings for one tool. */
export const DRAFT_SYSTEM_PREFIX = 'You are drafting prose for Caotang.';
/** The first words of a delegated agent's system message (agent-harness §2, "Delegate"). The mock scripts match on it (gateway mock). */
export const SUBAGENT_SYSTEM_PREFIX = 'You are a delegated agent for Caotang.';

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
          maxItems: PLAN_STEPS_MAX,
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
  // A scan, not one regex: the lazy body between two `\s*` runs went quadratic on a long run of spaces.
  if (trimmed.length < 6 || !trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed;
  const body = trimmed.slice(3, -3);
  return (body.startsWith('json') ? body.slice(4) : body).trim();
}

const SHAPE_HINT =
  'Reply with exactly one JSON object and nothing else: {"steps": [{"tool": "<name>", "params": {...}, "expect": "<effect>"}]} to call tools, or {"reply": "<text>"} to answer.';

/**
 * A reply whose steps the plan schema refused, as the words the model reads next. Both wires send this
 * same text — the JSON wire as its parse error, the native wire after the calls' tool results — so a
 * refusal reads the same however the model spoke.
 */
export function stepsRefusalMessage(error: CommandError): string {
  const hint = error.correctiveHint === undefined ? '' : ` ${error.correctiveHint}`;
  return `Your steps were refused: ${error.message}.${hint}`;
}

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
    if (!checked.ok) return err(stepsRefusalMessage(checked.error));
    return ok({ kind: 'steps', plan: checked.value as unknown as Plan });
  }
  if (typeof value['reply'] === 'string') {
    if (value['reply'].trim() === '') return err(`Your reply was blank. ${SHAPE_HINT}`);
    return ok({ kind: 'reply', text: value['reply'] });
  }
  return err(`Your reply had neither "steps" nor "reply". ${SHAPE_HINT}`);
}

/**
 * What a planner call declares beyond the core rows (agent-harness §3). `loaded` is the deferred native rows the turn has loaded
 * by `tool.search` or a preload; `all` declares every callable, wired row, which is Settings › Agent "Load every tool on every
 * request" (the escape hatch for a model that searches poorly).
 */
export interface PlannerSurface {
  readonly loaded?: readonly ToolListing[];
  readonly all?: boolean;
  /** A closed allowlist of names: only these rows are offered, whatever else the surface would admit. A delegated agent's listing is built with it. */
  readonly only?: readonly string[];
}

/**
 * The planner's callable surface this turn: the tools the model may call — callable and wired, with
 * the superseded read hidden once the review is wired (see `plannerSystem`), and a deferred row only
 * once the turn has loaded it. The system message lists the core rows alone (`plannerSystem`); the
 * native tool declarations add the rows loaded this turn, so a load never changes the cached prefix.
 */
export function plannerTools(tools: readonly ToolListing[], surface: PlannerSurface = {}): readonly ToolListing[] {
  // continuity.scan is superseded by the coherence review once the review is wired (agent-harness §3, tool 10's note): the review
  // writes its findings to the inbox, where continuity.scan's stay in the transcript. The tool stays callable for older turns.
  const reviewWired = tools.some((tool) => tool.name === 'coherence.review' && tool.callable && tool.wired);
  const loaded = new Set(surface.loaded?.map((tool) => tool.name));
  const only = surface.only === undefined ? undefined : new Set(surface.only);
  return tools.filter(
    (tool) =>
      tool.callable &&
      tool.wired &&
      tool.externalOnly !== true &&
      !(reviewWired && tool.name === 'continuity.scan') &&
      (only === undefined || only.has(tool.name)) &&
      (surface.all === true || tool.load === 'core' || loaded.has(tool.name)),
  );
}

/**
 * An external tool's description as it reaches the model in the planner prompt or the native tools
 * declaration. The full text remains in the approval card (extensibility §4 rule 5); the excerpt
 * shrinks the ambient poisoning surface to the budget the spec sets for the model-facing side
 * (extensibility §4 rule 4).
 */
function clipExternalDescription(description: string): string {
  // The one clipping rule, shared with `tool.search`'s excerpt (mcp-client `clipChars`): at most
  // EXCERPT_CHARS UTF-16 units including the ellipsis, cut on a code-point boundary, so the model
  // reads the same excerpt before and after a tool is loaded and never a lone surrogate.
  return clipChars(description, EXCERPT_CHARS);
}

/**
 * The tools a native-mode request declares: the core rows, then the deferred native rows the turn has loaded, then the external
 * tools it has loaded. A native tool goes by its registry name, an external one by the qualified name
 * `tool.search` returned; a native tool's description is Caotang's own text (in full) and an
 * external tool's is clipped to the spec's excerpt budget so the model's ambient context stays
 * bounded. The list is built fresh for each request, so a tool a mid-turn search loaded joins the
 * next request. `only` closes the list to the named rows (a delegated agent's), and then no external tool is declared.
 */
export function plannerToolDefs(
  tools: readonly ToolListing[],
  loadedNative: readonly ToolListing[],
  externals: readonly ExternalToolDescriptor[],
  all = false,
  only?: readonly string[],
): ToolDef[] {
  return [
    ...plannerTools(tools, { loaded: loadedNative, all, ...(only === undefined ? {} : { only }) }).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema })),
    ...(only === undefined ? externals : []).map((tool) => ({ name: tool.qualifiedName, description: clipExternalDescription(tool.description), parameters: tool.inputSchema })),
  ];
}

/**
 * A native call's arguments, parsed. A call that names no arguments is read as none; one whose JSON does
 * not parse or is not an object is a refusal the model corrects, like a JSON reply it cannot parse.
 */
export function callArgs(call: WireToolCall): { readonly params?: CallParams; readonly error?: string } {
  const source = call.argumentsJson.trim();
  if (source === '') return { params: {} };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { error: 'the call\'s arguments were not valid JSON, so it did not run: send the call again with its arguments as one JSON object' };
  }
  if (!isRecord(value)) {
    return { error: `the call's arguments must be one JSON object, and this call sent ${value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`}: send the call again with its arguments as one JSON object` };
  }
  return { params: value };
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

/** The one L0 line that tells the model deferred tools exist (context-assembly §2). Worded without a count, so it never changes. */
export const MORE_TOOLS_LINE = 'More tools exist; call tool.search with a word from the task to load them.';

function plannerPrompt(tools: readonly ToolListing[], all: boolean, wire: { readonly hint?: string; readonly rules: readonly string[] }): string {
  const offered = plannerTools(tools, { all });
  const lines = offered.map((tool) => `- ${tool.name} [${tool.risk}] — ${tool.description}\n  params: ${JSON.stringify(tool.schema)}`);
  return [
    `${PLANNER_SYSTEM_PREFIX} You act on the user's project only through the tools below.`,
    '',
    ...(wire.hint === undefined ? [] : [wire.hint, '']),
    'Rules:',
    ...wire.rules,
    '',
    'Tools:',
    ...lines,
    // L0 lists the core rows only and is built once per turn, so it is the same bytes whatever the turn loads. The tools a turn
    // loads (extensibility §5) reach the planner after the system prompt, in `loadedToolsMessage`, never here.
    ...(offered.some((tool) => tool.name === 'tool.search') ? ['', MORE_TOOLS_LINE] : []),
  ].join('\n');
}

/**
 * The planner's system message: the protocol, and the core tools that can be called in this build, each
 * with its risk, its description and its schema, then the line that more tools load through `tool.search`. Built from
 * the registry, so a tool the registry does not list cannot be offered to the model. `all` lists every callable row.
 */
export function plannerSystem(tools: readonly ToolListing[], all = false): string {
  return plannerPrompt(tools, all, { hint: SHAPE_HINT, rules: JSON_WIRE_RULES });
}

/**
 * The planner's system message when the request declares its tools natively: the same tools, and the
 * same rules worded for calls instead of the JSON envelope — there is no reply shape to state,
 * because the calls themselves are the reply.
 */
export function plannerSystemNative(tools: readonly ToolListing[], all = false): string {
  return plannerPrompt(tools, all, { rules: NATIVE_WIRE_RULES });
}

/**
 * The tools a search or a preload loaded this turn, as the model reads them (extensibility §5), in the message slot after the
 * system prompt. A native row goes by its registry name with its risk, Caotang's own description in full, and its schema. An
 * external tool goes by its qualified name with its risk, its description as the spec's model-facing excerpt (rule 4), and
 * its input schema. The full description still reaches the writer on the approval card (rule 5); here the model only sees the
 * excerpt so the ambient poisoning surface stays bounded. A read runs at once; a write asks the writer on a card, per call.
 */
export function loadedToolsMessage(native: readonly ToolListing[], externals: readonly ExternalToolDescriptor[] = []): string {
  return [
    'Tools loaded for this turn. Call each by the name shown, with params that match its schema. A write asks the writer to confirm each call before it runs.',
    ...native.map((tool) => `- ${tool.name} [${tool.risk}] — ${tool.description}\n  params: ${JSON.stringify(tool.schema)}`),
    ...externals.map((tool) => `- ${tool.qualifiedName} [${tool.effectiveRisk === 'read-auto' ? 'read' : 'write'}] — ${clipExternalDescription(tool.description)}\n  params: ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
}

/**
 * A note the writer sent while the turn ran (agent-harness §2, "Stop and steer"), as the planner reads it: one user message per
 * note, worded so the model knows where it came from.
 */
export function steeringMessage(text: string): string {
  return `Note from the writer, sent while you were working: ${text}`;
}

/** What the planner is told when the writer cancels its plan card and sends a note with the Cancel: the turn goes on with the note. */
export const PLAN_CANCELLED_MESSAGE = 'The writer cancelled the plan you proposed, so the steps it had not run yet will not run.';

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
