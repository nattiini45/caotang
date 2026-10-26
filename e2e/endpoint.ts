/**
 * A fake OpenAI-compatible endpoint, served to the page by Playwright's route interception (not a server). It runs the
 * app's real transport, so the list-models probe, the response-format probe and the streamed planner reply all travel the
 * same path a real provider's would. The profile is a generic endpoint — key-optional, so the fake needs none — and
 * Playwright answers its https calls before any network sees them (provider-gateway §2, §7).
 *
 * `reply` answers each chat request with the text the model "writes". A planner call (the agent's system message) gets its
 * plan the first time, and a plain reply after the results have come back.
 */

import { expect, type Page, type Route } from '@playwright/test';

import { writerText } from './support.js';

export const FAKE_ENDPOINT = 'https://127.0.0.1:5999/v1';

/** The chat request body as the app sends it, reduced to what the fake reads. */
export interface FakeRequest {
  readonly stream: boolean;
  readonly system: string;
  readonly assistantTurns: number;
  readonly user: string;
  /** The text of the tool results the request carries (the native wire answers each call with a message of its own). */
  readonly tool: string;
  /**
   * The tool names the request declared, when it is a native-wire call. The generic preset's capability row reports
   * `tools`, so the app's planner speaks tool calls to the fake — a reply that wants a plan must send `toolCalls`,
   * not the JSON envelope (provider-gateway §3's two wires).
   */
  readonly tools?: readonly string[];
}

/** One tool call a native-wire reply makes: `name` is the tool, `arguments` its params as a JSON string. */
export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** What a chat request is answered with: the reply text, and optionally the reasoning the model "thought" first. */
export interface FakeAnswer {
  readonly text: string;
  readonly reasoning?: string;
  /** Native-wire calls the reply asks for; when present the finish reason is 'tool_calls'. */
  readonly toolCalls?: readonly FakeToolCall[];
}

export type FakeReply = (request: FakeRequest) => string | FakeAnswer;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function parse(route: Route): FakeRequest {
  const body = JSON.parse(route.request().postData() ?? '{}') as {
    stream?: boolean;
    messages?: { role: string; content: string }[];
    tools?: { function?: { name?: string } }[];
  };
  const messages = body.messages ?? [];
  const first = messages[0];
  const tools = body.tools?.map((tool) => tool.function?.name ?? '').filter((name) => name !== '');
  return {
    stream: body.stream !== false,
    system: first?.role === 'system' ? first.content : '',
    assistantTurns: messages.filter((message) => message.role === 'assistant').length,
    user: messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n'),
    tool: messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .join('\n'),
    ...(tools === undefined ? {} : { tools }),
  };
}

/**
 * One Server-Sent Events body, as an OpenAI-style stream: the reasoning as one `reasoning_content` delta when the reply
 * carries any (the field the chat adapter reads), then the text as one delta, then each tool call as a `tool_calls`
 * delta, then the finish reason — 'tool_calls' when calls were asked for — and usage.
 */
function sse(answer: string | FakeAnswer): string {
  const { text, reasoning, toolCalls } =
    typeof answer === 'string' ? { text: answer, reasoning: undefined, toolCalls: undefined } : answer;
  const chunks = [
    ...(reasoning === undefined ? [] : [{ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] }]),
    ...(text === '' ? [] : [{ choices: [{ delta: { content: text }, finish_reason: null }] }]),
    ...(toolCalls ?? []).map((call, index) => ({
      choices: [
        {
          delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
          finish_reason: null,
        },
      ],
    })),
    {
      choices: [{ delta: {}, finish_reason: toolCalls !== undefined && toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: Math.ceil((text.length + (reasoning?.length ?? 0)) / 4) },
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * Routes every request to one endpoint origin through `reply`, answering its model list with `models`. Call it before
 * the page makes the requests (before `goto`, or before the click that starts them). Preset profiles whose URLs are
 * their own (a region or workspace template) route their origin here, so no save-time probe reaches a real network.
 */
export async function endpointRoute(
  page: Page,
  origin: string,
  reply: FakeReply,
  models: readonly string[] = ['test-model', 'other-model'],
): Promise<void> {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/models')) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ data: models.map((id) => ({ id })) }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const parsed = parse(route);
      if (!parsed.stream) {
        // The response-format probe asks for a JSON object and gets one.
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] }),
        });
        return;
      }
      await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(reply(parsed)) });
      return;
    }
    await route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  });
}

/**
 * Routes every request to the fake endpoint through `reply`. Call it before the page makes the requests (before `goto`,
 * or before the click that starts them).
 */
export async function fakeEndpoint(page: Page, reply: FakeReply): Promise<void> {
  await endpointRoute(page, 'https://127.0.0.1:5999', reply);
}

/**
 * The planner's first reply is `plan`; every later one is a plain answer, so a turn ends after its results. A drafting call
 * (the prose a drafted step writes) gets `draft`, so a step the model writes is the text the test names.
 *
 * The wire decides the shape: a request that declares tools (the native wire) is answered with `tool_calls` — one per
 * planned step — and the plan's expectations joined as its text, since a native step's `expect` is the reply's own
 * words; a request without tools gets the JSON envelope the reply parser reads.
 */
export function planThenAnswer(plan: unknown, answer = 'Done.', draft = 'A drafted synopsis.'): FakeReply {
  return (request) => {
    if (request.system.startsWith('You are drafting prose')) return draft;
    const steps = (plan as { steps?: readonly { tool: string; params?: Record<string, unknown>; expect?: string }[] }).steps;
    const native = request.tools !== undefined;
    if (request.assistantTurns === 0 && native && steps !== undefined && steps.length > 0) {
      return {
        text: steps.map((step) => step.expect).filter((expect) => expect !== undefined && expect !== '').join('. '),
        toolCalls: steps.map((step, index) => ({ id: `call_${index + 1}`, name: step.tool, arguments: JSON.stringify(step.params ?? {}) })),
      };
    }
    if (request.assistantTurns === 0 && !native) return JSON.stringify(plan);
    return native ? { text: answer } : JSON.stringify({ reply: answer });
  };
}

/**
 * Adds the fake endpoint as a profile and makes it the active one, through Settings on the projects screen. The endpoint must be
 * routed (`fakeEndpoint`) before this, since saving it lists its models.
 */
export async function useFakeEndpoint(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  // Labels are scoped to the profile form: 'Name' and 'Model' also name the role picker's fields below it.
  const form = settings.getByRole('form', { name: 'New provider' });
  // The fake speaks the OpenAI-Chat dialect, so the profile is a hand-rolled (generic) endpoint.
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Fake endpoint');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(new RegExp(`Saved “${writerText('Fake endpoint')}”\\.`))).toBeVisible();
  await settings.locator('[data-profile="Fake endpoint"]').getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.getByText('is now the active profile')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
}
