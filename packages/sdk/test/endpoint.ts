/**
 * A model endpoint that is a function: the OpenAI-compatible chat route, answered from a script, so a test can run the SDK against a
 * real profile (a key, an origin, the gateway's egress pin and redaction) with no network and no real provider.
 */

import { DRAFT_PREFIX, PLANNER_PREFIX } from '@caotang/gateway/mock';

export interface SeenRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly system: string;
  readonly user: string;
}

export type EndpointReply =
  | { readonly kind: 'text'; readonly text: string; readonly finish?: 'stop' | 'length' }
  /** The planner's step, on the wire the request asks for: a tool call when it declares tools, the JSON envelope when it does not. */
  | { readonly kind: 'step'; readonly tool: string; readonly params: object; readonly expect: string }
  | { readonly kind: 'error'; readonly status: number; readonly body: string };

export interface Endpoint {
  readonly fetch: typeof fetch;
  readonly requests: SeenRequest[];
}

interface ChatBody {
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
  readonly tools?: readonly unknown[];
}

const EVENT_END = '\n\n';
const chunkOf = (delta: object, finish: string | null): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}${EVENT_END}`;
const USAGE = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}${EVENT_END}`;
const DONE = `data: [DONE]${EVENT_END}`;

const stream = (sse: string): Response => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));

export function endpoint(reply: (request: SeenRequest, kind: 'planner' | 'draft' | 'other') => EndpointReply): Endpoint {
  const requests: SeenRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ChatBody;
    const messages = body.messages ?? [];
    const headers = new Headers(init?.headers);
    const seen: SeenRequest = {
      url: String(input),
      authorization: headers.get('authorization'),
      system: textOf(messages.find((m) => m.role === 'system')?.content ?? ''),
      user: messages
        .filter((m) => m.role === 'user')
        .map((m) => textOf(m.content))
        .join('\n\n'),
    };
    requests.push(seen);
    const kind = seen.system.startsWith(PLANNER_PREFIX) ? 'planner' : seen.system.startsWith(DRAFT_PREFIX) ? 'draft' : 'other';
    const answer = reply(seen, kind);
    if (answer.kind === 'error') return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });

    if (answer.kind === 'step' && (body.tools?.length ?? 0) > 0) {
      const call = { index: 0, id: 'call_test_1', type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.params) } };
      return stream(chunkOf({ role: 'assistant', content: '', tool_calls: [call] }, null) + chunkOf({}, 'tool_calls') + USAGE + DONE);
    }
    const text = answer.kind === 'step' ? JSON.stringify({ steps: [{ tool: answer.tool, params: answer.params, expect: answer.expect }] }) : answer.text;
    const finish = answer.kind === 'text' ? (answer.finish ?? 'stop') : 'stop';
    return stream(chunkOf({ role: 'assistant', content: text }, null) + chunkOf({}, finish) + USAGE + DONE);
  };
  return { fetch: fakeFetch, requests };
}

/** The planner's reply that stages one `scene.draft` of The Friend. */
export const DRAFT_THE_FRIEND: EndpointReply = {
  kind: 'step',
  tool: 'scene.draft',
  params: { doc: 'The Friend', instruction: 'The friend arrives by boat, soaked, with news of Elena.', mode: 'draft' },
  expect: 'The Friend holds a drafted opening scene',
};

/** The base URL and profile every endpoint-backed test opens its project with. */
export const TEST_PROFILE = { name: 'Test endpoint', baseUrl: 'https://llm.example.test/v1', defaultModel: 'test-model' } as const;
