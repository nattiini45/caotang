/**
 * Mock scripts for the eval scenarios. A scenario's model is a short transcript: the planner's replies
 * in order, one per planner call, and the prose a drafting call returns. The planner's call count is
 * the number of assistant messages already in the conversation, so a scripted retry consumes the next
 * reply exactly as a live model would.
 */

import { draftScript, isPlannerCall, plannerScript, userTextOf } from '@caotang/gateway/mock';
import type { MockScript } from '@caotang/gateway/mock';
import type { ChatRequest } from '@caotang/gateway';

/** A planner reply that calls the given steps, in order. */
export function steps(...calls: readonly { readonly tool: string; readonly params: Record<string, unknown>; readonly expect: string }[]): string {
  return JSON.stringify({ steps: calls });
}

/** A planner reply that answers without calling a tool. */
export function answer(text: string): string {
  return JSON.stringify({ reply: text });
}

/**
 * The planner's replies for one intent: the nth call gets the nth reply, and the last reply repeats once they run out.
 * `seen`, when given, collects each planner request for the intent in the order it was sent, so a test can read what
 * the model was shown.
 */
export function transcript(intent: string, replies: readonly string[], seen?: ChatRequest[]): MockScript {
  return plannerScript((req: ChatRequest) => {
    if (!userTextOf(req).includes(`Request: ${intent}`)) return undefined;
    // `plannerScript` asks for the reply twice per request (once to match, once to answer), so a request is kept once.
    if (seen !== undefined && seen[seen.length - 1] !== req) seen.push(req);
    const calls = req.messages.filter((message) => message.role === 'assistant').length;
    return replies[Math.min(calls, replies.length - 1)];
  });
}

/**
 * The same intent's replies on the native wire: the first planner call asks for one tool, and a later one answers
 * `done` without calling anything. A native request is the one that declares tools, which is also how the wire tells
 * itself apart from JSON mode.
 */
export function nativeTranscript(intent: string, call: { readonly tool: string; readonly params: Record<string, unknown> }, done: string): MockScript {
  return {
    match: (req: ChatRequest) => (req.tools?.length ?? 0) > 0 && userTextOf(req).includes(`Request: ${intent}`),
    respond: (req: ChatRequest, callIndex?: number) => {
      const replies = req.messages.filter((message) => message.role === 'assistant').length;
      if (replies > 0) return { content: done };
      return { content: '', toolCalls: [{ id: `call_mock_${callIndex ?? 1}`, name: call.tool, argumentsJson: JSON.stringify(call.params) }] };
    },
  };
}

/** Prose for a drafting call whose user text carries the marker. Prose is asked for as `'text'`. */
export function prose(marker: string, text: string): MockScript {
  return draftScript((req) => (req.responseFormat === 'text' && userTextOf(req).includes(marker) ? text : undefined));
}

/** The first planner call of any intent, for a scenario that wants a default reply to anything it did not script. */
export function plannerDefault(reply: string): MockScript {
  return { match: (req) => isPlannerCall(req), respond: () => ({ content: reply }) };
}
