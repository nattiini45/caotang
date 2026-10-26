/**
 * Mock scripts for the agent protocol — provider-gateway §8's "scriptable" contract, applied to the
 * harness's tool-call protocol, and the three zero-key demo intents of context-assembly §6.
 *
 * ## How a script knows which call it is answering
 *
 * The harness sends two kinds of request, and each is recognisable by the first words of its system
 * message and by its `responseFormat`:
 *
 * - the **planner** (`PLANNER_PREFIX`, a JSON schema hint): its reply is `{"steps": [...]}` or `{"reply": "..."}`;
 * - a **drafting** call (`DRAFT_PREFIX`): its reply is prose, a synopsis, or a JSON findings list;
 * - a **delegated agent's** call (`SUBAGENT_PREFIX`, agent-harness §2): it speaks the planner's reply protocol, `{"steps": [...]}` or `{"reply": "..."}`.
 *
 * Within the planner, a script decides from the transcript alone. A request with no earlier reply is a
 * first call; one after a "Tool results" message is a follow-up; one after a refused step is a retry.
 * So a script is a pure function of its request, and the same request always gets the same bytes.
 *
 * `PLANNER_PREFIX`, `DRAFT_PREFIX` and `SUBAGENT_PREFIX` are duplicated from `@caotang/harness` (agent/protocol.ts). The
 * gateway must not depend on the harness, and the harness's own test asserts the two copies agree.
 */

import type { ChatChunk, ChatMessage, ChatRequest } from '../types.js';
import type { MockResponse, MockScript } from './scripts.js';

/** The first words of the planner's system message. The harness's protocol.ts holds the same string. */
export const PLANNER_PREFIX = "You are Caotang's agent.";
/** The first words of a drafting call's system message. The harness's protocol.ts holds the same string. */
export const DRAFT_PREFIX = 'You are drafting prose for Caotang.';
/** The first words of a delegated agent's system message. The harness's protocol.ts holds the same string. */
export const SUBAGENT_PREFIX = 'You are a delegated agent for Caotang.';
/**
 * The first words of the coherence review's two model stages (coherence.md §5.3): Stage 1 extracts checkable statements from one
 * document, Stage 2 judges pairs of them. The coherence module's prompts.ts holds the same strings, and a harness test asserts they agree.
 */
export const EXTRACTOR_PREFIX = 'You are a continuity extractor for a manuscript.';
export const VERIFIER_PREFIX = 'You judge whether two passages from one manuscript contradict each other.';

/**
 * The three zero-key demo intents of context-assembly §6. The first-run wizard sends these exact strings. `review` is the typed
 * request that runs the model review (coherence.md §5.3) on the demo provider: the first-run card does not offer it, because the review
 * asks for approval and a turn that waits for approval holds the agent. `instructions` is the Agent instructions panel's "Initialise from
 * this project": the demo answers it with one canned CAOTANG.md, proposed on a confirm card, since it cannot read the manuscript.
 */
export const DEMO_INTENTS = {
  draftScene: 'Draft the opening scene of The Friend.',
  fillSynopses: 'Fill in the synopses for Chapter 1.',
  continuity: 'Check the manuscript for continuity problems.',
  review: 'Review the manuscript for contradictions.',
  instructions: 'Read my manuscript and propose a first CAOTANG.md for it: its spelling, its tense and its point of view.',
} as const;

function systemOf(req: ChatRequest): string {
  const first = req.messages[0];
  return first?.role === 'system' ? first.content : '';
}

/** Every user message of a request, in order, joined. A script reads the request's wording through it. */
export function userTextOf(req: ChatRequest): string {
  return req.messages
    .filter((message: ChatMessage) => message.role === 'user')
    .map((message) => message.content)
    .join('\n\n');
}

/** Whether a request is the planner's: the agent's system message, with a JSON schema hint. */
export function isPlannerCall(req: ChatRequest): boolean {
  return systemOf(req).startsWith(PLANNER_PREFIX) && typeof req.responseFormat === 'object';
}

/** Whether a request is a delegated agent's: its system message starts with the delegate prefix. */
export function isSubagentCall(req: ChatRequest): boolean {
  return systemOf(req).startsWith(SUBAGENT_PREFIX);
}

/** Whether a request is a drafting call for one tool's content. */
export function isDraftCall(req: ChatRequest): boolean {
  return systemOf(req).startsWith(DRAFT_PREFIX);
}

/** The assistant messages a request already carries: how far the conversation has gone. */
function repliesSoFar(req: ChatRequest): number {
  return req.messages.filter((message) => message.role === 'assistant').length;
}

/** The text of the last message, whichever role sent it. */
function lastMessageOf(req: ChatRequest): string {
  return req.messages.at(-1)?.content ?? '';
}

/** A script that answers planner calls with `reply(req)`, and passes every other request on. */
export function plannerScript(reply: (req: ChatRequest) => string | undefined): MockScript {
  return {
    match: (req) => isPlannerCall(req) && reply(req) !== undefined,
    respond: (req): MockResponse => ({ content: reply(req) ?? '' }),
  };
}

/**
 * A script that answers a delegated agent's calls with `reply(req)`. The delegate prefix is what selects it, whichever wire the agent speaks: a
 * reply with `toolCalls` is a native-wire reply (`MockResponse`), and a string is the JSON-in-text reply.
 */
export function subagentScript(reply: (req: ChatRequest) => string | MockResponse | undefined): MockScript {
  return {
    match: (req) => isSubagentCall(req) && reply(req) !== undefined,
    respond: (req): MockResponse => {
      const answer = reply(req);
      return typeof answer === 'string' ? { content: answer } : (answer ?? { content: '' });
    },
  };
}

/** A script that answers drafting calls with `reply(req)`. The drafting prefix is what selects it. */
export function draftScript(reply: (req: ChatRequest) => string | undefined): MockScript {
  return {
    match: (req) => isDraftCall(req) && reply(req) !== undefined,
    respond: (req): MockResponse => ({ content: reply(req) ?? '' }),
  };
}

/* ------------------------------------------------------------------ *
 * The three demo intents.
 * ------------------------------------------------------------------ */

/** A planner reply with one step: the tool, its params and the effect it should have. */
function oneStep(tool: string, params: Record<string, unknown>, expect: string): string {
  return JSON.stringify({ steps: [{ tool, params, expect }] });
}

/**
 * The count of findings in the last tool-results message, read back from its JSON: the sum of the counts its groups carry. Zero when
 * there are none.
 */
function findingsCountIn(req: ChatRequest): number {
  return [...lastMessageOf(req).matchAll(/"count":(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

/**
 * What the demo says when the loop calls the planner a second time for its draft. The loop settles a step that applied without another
 * model call (runWrites: `executed.ok` settles), so a second call means the step did not run: it was refused before any card, or the
 * draft did not apply, and the loop's last message says so. The demo never claims a draft it did not make.
 */
const DRAFT_NOT_MADE =
  'No draft was made, so nothing changed. The demo drafts into a scene called The Friend, and it could not write there. Check that a scene with that name is in the binder, then ask again.';

/** The loop refused the demo's write because the writer is in Plan only (agent-harness §4): the demo says what it would have done instead. */
const heldByPlanOnly = (req: ChatRequest): boolean => lastMessageOf(req).includes('Plan-only mode is on');

/** Intent 1 — draft a scene: one write-confirm call, so one confirm card, then an applied draft. */
const draftSceneReply = (req: ChatRequest): string | undefined => {
  if (!userTextOf(req).includes(`Request: ${DEMO_INTENTS.draftScene}`)) return undefined;
  if (repliesSoFar(req) > 0 && heldByPlanOnly(req)) return JSON.stringify({ reply: 'Plan: draft the opening scene in The Friend, from the brief about the friend arriving by boat. Nothing was written.' });
  if (repliesSoFar(req) > 0) return JSON.stringify({ reply: DRAFT_NOT_MADE });
  return oneStep('scene.draft', { doc: 'The Friend', instruction: 'The friend arrives by boat, soaked, with news of Elena.', mode: 'draft' }, 'The Friend holds a drafted opening scene');
};

/**
 * What the demo says when the loop calls the planner a second time for its synopses: as with the draft, a fill that applied settles
 * without another model call, so a second call means the step was refused or did not apply. The demo never claims synopses it did not
 * write.
 */
const SYNOPSES_NOT_FILLED =
  'No synopses were written, so nothing changed. The demo fills the synopses of two scenes called The Landing and The Storm, and it could not write there. Check that both are in the binder, then ask again.';

/** Intent 2 — fill synopses: one batched write-confirm call, previewed as a card of rows. */
const fillSynopsesReply = (req: ChatRequest): string | undefined => {
  if (!userTextOf(req).includes(`Request: ${DEMO_INTENTS.fillSynopses}`)) return undefined;
  if (repliesSoFar(req) > 0 && heldByPlanOnly(req)) return JSON.stringify({ reply: 'Plan: fill in the synopses of The Landing and The Storm. Nothing was written.' });
  if (repliesSoFar(req) > 0) return JSON.stringify({ reply: SYNOPSES_NOT_FILLED });
  return oneStep('synopsis.fill', { docs: ['The Landing', 'The Storm'], source: 'text', max_words: 30 }, 'Both chapters have a synopsis');
};

/**
 * Intent 3 — continuity: the deterministic scan (coherence.md §5.1), a read, so no card. Its findings go to the Findings inbox, and the
 * reply reports how many there are.
 */
const continuityReply = (req: ChatRequest): string | undefined => {
  if (!userTextOf(req).includes(`Request: ${DEMO_INTENTS.continuity}`)) return undefined;
  if (repliesSoFar(req) === 0) return oneStep('coherence.scan', { scope: { mode: 'full' } }, 'The scan lists the continuity problems in the Findings inbox');
  return reportOfFindings(req);
};

/**
 * The typed review request: the model review (coherence.md §5.3), which the planner stages as a card. Its findings go to the Findings
 * inbox once the writer approves the card, and the reply reports how many there are.
 */
const reviewReply = (req: ChatRequest): string | undefined => {
  if (!userTextOf(req).includes(`Request: ${DEMO_INTENTS.review}`)) return undefined;
  if (repliesSoFar(req) === 0) return oneStep('coherence.review', { scope: { mode: 'full' } }, 'The review finds the contradictions the manuscript holds');
  return reportOfFindings(req);
};

/** The reply after a findings tool: the count from its result, and where the findings are. */
function reportOfFindings(req: ChatRequest): string {
  const count = findingsCountIn(req);
  return JSON.stringify({ reply: count === 0 ? 'No continuity problems found.' : `Found ${count} continuity ${count === 1 ? 'finding' : 'findings'}, listed in the Findings inbox.` });
}

/** The CAOTANG.md the demo proposes: rules any manuscript can start from, since the demo reads none of it. */
export const DEMO_INSTRUCTIONS = [
  'Keep the spelling the manuscript already uses.',
  'Keep its tense and its point of view from scene to scene.',
  'End a scene on a line of dialogue where it can.',
  '',
].join('\n');

/**
 * Intent 4 — a first CAOTANG.md: one write-confirm call, so one confirm card that shows the file as a difference. The demo cannot read the
 * manuscript, so its draft is fixed.
 */
const instructionsReply = (req: ChatRequest): string | undefined => {
  if (!userTextOf(req).includes(`Request: ${DEMO_INTENTS.instructions}`)) return undefined;
  if (repliesSoFar(req) > 0 && heldByPlanOnly(req)) return JSON.stringify({ reply: 'Plan: propose a first CAOTANG.md for the project. Nothing was written.' });
  if (repliesSoFar(req) > 0) return JSON.stringify({ reply: 'CAOTANG.md was not changed. The proposal was refused or not approved, so the file is as it was.' });
  return oneStep('instructions.propose', { text: DEMO_INSTRUCTIONS }, 'CAOTANG.md holds the first rules');
};

/**
 * The words of a text, one chunk each, with a turn of the event loop between them: how a provider streams a draft, so the text shows in
 * the ghost as it grows. `setTimeout` rather than `setImmediate`, because the demo provider runs in the browser too.
 */
async function* wordsOf(text: string): AsyncIterable<ChatChunk> {
  for (const word of text.split(/(?<=\s)/)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (word.length > 0) yield { delta: word };
  }
}

/** A drafting script whose prose streams in word-sized chunks, as a provider sends it. */
function streamedDraftScript(reply: (req: ChatRequest) => string | undefined): MockScript {
  return {
    match: (req) => isDraftCall(req) && reply(req) !== undefined,
    respond: (req) => wordsOf(reply(req) ?? ''),
  };
}

/** The prose a demo draft returns. Fixed, so the demo's end state is the same on every run. */
const DEMO_PROSE =
  'The ferry came in on the evening tide, low in the water and slow to answer the rope. Elena was not on it. The friend stepped onto the wet stones with a folded letter in one hand and a lantern that had gone out long before the harbour wall.';

/** Prose is asked for as `'text'`; a structured reply carries a schema hint. The two drafting scripts tell their calls apart by this. */
const isProse = (req: ChatRequest): boolean => req.responseFormat === 'text';

const draftSceneDraft = streamedDraftScript((req) => (isProse(req) && userTextOf(req).includes('Brief: The friend arrives by boat') ? DEMO_PROSE : undefined));

/**
 * The rewrite a "Fix with agent" asks for (coherence.md §6.3): one passage, which no longer contradicts the timeline. Only the demo
 * statement of the demo document is rewritten, with that statement's own rewrite: the passage must be the quote of the document the
 * focus frame names, so the same sentence in the writer's own scene falls through to the refusal below, and the demo never puts its
 * sentence into that scene.
 */
const rewriteDraft = streamedDraftScript((req) => {
  if (!isProse(req)) return undefined;
  const text = userTextOf(req);
  if (!text.includes('Rewrite this passage so it no longer conflicts')) return undefined;
  // The focus layer names the document on its "Document: <title> (rewrite selection;" line, and the selection on its own line
  // after "Selection to rewrite:" (context-assembly, the focus layer).
  const title = /^Document: ([^\n]*?) \(rewrite selection;/m.exec(text)?.[1];
  const selection = /Selection to rewrite:\n([^\n]*)/.exec(text)?.[1]?.trim();
  const statement = title === undefined ? undefined : demoStatementOf(title);
  return statement !== undefined && selection === statement.quote ? statement.rewrite : undefined;
});

/** The brief line a synopsis call carries (loop.ts, synopsis.fill). A scene draft of the same chapter does not carry it. */
const SYNOPSIS_BRIEF = 'Brief: write the synopsis of this document.';

const fillSynopsesDraft = draftScript((req) => {
  if (!isProse(req)) return undefined;
  const text = userTextOf(req);
  if (!text.includes(SYNOPSIS_BRIEF)) return undefined;
  if (text.includes('Document "The Landing":')) return 'Elena comes back to the island to settle her father’s boat, and finds the harbour changed.';
  if (text.includes('Document "The Storm":')) return 'A storm takes the lamp, and the keeper must choose between the light and the boat.';
  return undefined;
});

/* ------------------------------------------------------------------ *
 * The coherence review's two model stages, scripted for the demo manuscript (coherence.md §5.3).
 * ------------------------------------------------------------------ */

/**
 * The statement each demo document holds that a later passage can contradict: the Landing's late ferry, the Storm's failed lamp. Each
 * carries the rewrite Fix with agent drafts for it, a sentence about the same event that puts it in order with the other.
 */
interface DemoStatement {
  readonly quote: string;
  readonly note: string;
  readonly rewrite: string;
}

const DEMO_STATEMENTS: Readonly<Record<string, DemoStatement>> = {
  'The Landing': {
    quote: 'The ferry was late, as always.',
    note: 'The ferry is late before the storm has broken.',
    rewrite: 'The ferry was late, held at the mainland until the storm had passed.',
  },
  'The Storm': {
    quote: 'The lamp failed.',
    note: 'The storm is said to break before the ferry is late, so the order of the two events needs checking.',
    rewrite: 'The lamp failed once the ferry was already in.',
  },
};

/**
 * The demo statement of the document with this title, or undefined for any other document. An own-property lookup, so a title such
 * as `constructor` names no statement.
 */
function demoStatementOf(title: string): DemoStatement | undefined {
  return Object.hasOwn(DEMO_STATEMENTS, title) ? DEMO_STATEMENTS[title] : undefined;
}

/** The document a Stage 1 call reads: its title and id, and the body the prompt sends between its markers. */
function documentOf(req: ChatRequest): { title: string; docId: string; body: string } | undefined {
  const text = userTextOf(req);
  const head = /Focus document "([^"]*)" \(docId: ([^)]*)\):/.exec(text);
  const body = /--- BEGIN DOCUMENT ---\n([\s\S]*?)\n--- END DOCUMENT ---/.exec(text);
  if (head === null || body === null) return undefined;
  return { title: head[1] ?? '', docId: head[2] ?? '', body: body[1] ?? '' };
}

/** Stage 1: the demo statement of the document, as one span at its offsets in the body the prompt sent. */
const extractionScript: MockScript = {
  match: (req) => systemOf(req).startsWith(EXTRACTOR_PREFIX),
  respond: (req) => {
    const document = documentOf(req);
    const statement = document === undefined ? undefined : demoStatementOf(document.title);
    const from = document === undefined || statement === undefined ? -1 : document.body.indexOf(statement.quote);
    const spans =
      document === undefined || statement === undefined || from < 0
        ? []
        : [{ docId: document.docId, from, to: from + statement.quote.length, quote: statement.quote, category: 'timeline-plot', note: statement.note }];
    return { content: JSON.stringify({ spans }) };
  },
};

/** One side of a Stage 2 pair, as its passage names it: the document, the offsets, and the quote in its brackets. */
interface PassageOf {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
  readonly quote: string;
}

/** The pairs a Stage 2 call judges, read from the `[pair pN]` blocks of its prompt. */
function pairsOf(text: string): { pairId: string; a: PassageOf; b: PassageOf }[] {
  const pairs: { pairId: string; a: PassageOf; b: PassageOf }[] = [];
  for (const block of text.split(/\n\n(?=\[pair )/)) {
    const pairId = /^\[pair (p\d+)\]/.exec(block)?.[1];
    const a = block.indexOf('Passage A (');
    const b = block.indexOf('Passage B (');
    if (pairId === undefined || a < 0 || b < 0) continue;
    const passageAt = (segment: string): PassageOf | undefined => {
      const head = /docId ([^,]*), offsets (\d+)-(\d+)\)/.exec(segment);
      const quote = /\[\[([\s\S]*?)\]\]/.exec(segment);
      if (head === null || quote === null) return undefined;
      return { docId: head[1] ?? '', from: Number(head[2]), to: Number(head[3]), quote: quote[1] ?? '' };
    };
    const first = passageAt(block.slice(a, b));
    const second = passageAt(block.slice(b));
    if (first !== undefined && second !== undefined) pairs.push({ pairId, a: first, b: second });
  }
  return pairs;
}

/** Stage 2: each pair of demo statements is contradictory, with the two passages as its evidence. */
const verificationScript: MockScript = {
  match: (req) => systemOf(req).startsWith(VERIFIER_PREFIX),
  respond: (req) => ({
    content: JSON.stringify({
      verdicts: pairsOf(userTextOf(req)).map(({ pairId, a, b }) => ({
        pairId,
        verdict: 'contradictory',
        reasoning: 'The Landing has the ferry late before the storm, but The Storm has the storm breaking first.',
        evidence: [a, b],
        factGroup: { entity: 'the storm', attribute: 'the order of the ferry and the lamp' },
      })),
    }),
  }),
};

/**
 * What the demo says to a request none of its three intents matches. The words are the planner's fallback reply
 * in the product's demo provider (app-provider.ts, DEMO_FALLBACK_REPLY), which is built from this one constant.
 */
export const DEMO_REFUSAL =
  'The built-in demo answers only the three demo requests. Add a provider in Settings > Providers to ask for anything else.';

/**
 * Refuses every request the three intents above do not answer, except the planner's: the app answers a planner request it does not
 * know with a plain reply (providers.ts). A refusal is an error and never text, because a drafting call's text becomes a draft, and
 * the demo must not write a project overview into a scene (coherence.md §6.3, context-assembly §6). It is last in the list, so each
 * intent matches first, and the app's echo fallback never answers a request the demo did not script.
 */
const refuseOtherRequests: MockScript = {
  match: (req) => !isPlannerCall(req),
  respond: (): MockResponse => ({ content: '', error: { kind: 'provider', status: 400, message: DEMO_REFUSAL } }),
};

/**
 * The scripts for the three zero-key demo intents, then the refusal of everything else. Match order matters only for the
 * refusal, which must come after the intents; each intent matches on its own wording.
 */
export const demoScripts: readonly MockScript[] = [
  plannerScript(draftSceneReply),
  plannerScript(fillSynopsesReply),
  plannerScript(continuityReply),
  plannerScript(reviewReply),
  plannerScript(instructionsReply),
  draftSceneDraft,
  rewriteDraft,
  fillSynopsesDraft,
  extractionScript,
  verificationScript,
  refuseOtherRequests,
];
