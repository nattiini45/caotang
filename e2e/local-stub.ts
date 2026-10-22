/**
 * A stub of a local model server, for the browser to call over loopback. It imitates what each product does with a
 * cross-origin request out of the box (providers-browser-cors.md §4), so the CORS fixes the app names can be tested end
 * to end: the stub refuses the page until the setting the message names is applied. It proves the app's wiring and
 * messages against a real browser's CORS check; it does not prove the real products behave this way, which is a manual check.
 *
 * The page under test is itself served from loopback, which real Ollama and llama-server admit by default. The stub
 * therefore models the default for a *deployed* origin (caotang.app): a web origin is refused until it is configured.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubProduct = 'ollama' | 'lmstudio' | 'llamacpp';

export interface StubConfig {
  readonly product: StubProduct;
  /** Ollama: the origins OLLAMA_ORIGINS adds. LM Studio: ignored. llama-server: `--cors-origins`; absent means it reflects any origin. */
  readonly origins?: readonly string[];
  /** LM Studio's Enable CORS switch. */
  readonly cors?: boolean;
}

/** The non-web origins Ollama admits with no setting (its documented default list, minus the loopback hosts; see the file note). */
const OLLAMA_DEFAULT_SCHEMES = ['app://', 'file://', 'tauri://', 'vscode-webview://'];

/** The Access-Control-Allow-Origin value this product answers an Origin with, or undefined for no CORS headers at all. */
export function allowOrigin(config: StubConfig, origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  switch (config.product) {
    case 'ollama':
      return OLLAMA_DEFAULT_SCHEMES.some((scheme) => origin.startsWith(scheme)) || (config.origins ?? []).includes(origin) ? origin : undefined;
    case 'lmstudio':
      return config.cors === true ? '*' : undefined;
    case 'llamacpp':
      return config.origins === undefined || config.origins.includes(origin) ? origin : undefined;
  }
}

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface LocalStub {
  /** `http://127.0.0.1:<port>/v1` */
  readonly baseUrl: string;
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

function chat(res: ServerResponse, stream: boolean, headers: Record<string, string>): void {
  if (!stream) {
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] }));
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the stub.' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part: string) => (body += part));
    req.on('end', () => resolve(body));
  });
}

/** Starts the stub on a free loopback port. */
export async function startLocalStub(config: StubConfig): Promise<LocalStub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
      const origin = req.headers.origin;
      const allowed = allowOrigin(config, typeof origin === 'string' ? origin : undefined);
      const cors: Record<string, string> =
        allowed === undefined
          ? {}
          : { 'access-control-allow-origin': allowed, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' };

      if (req.method === 'OPTIONS') {
        // A preflight from a refused origin carries no allow headers, so the browser blocks the real request.
        res.writeHead(allowed === undefined ? 403 : 204, cors);
        res.end();
        return;
      }
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { stream?: boolean };
        chat(res, parsed.stream !== false, cors);
        return;
      }
      res.writeHead(404, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
