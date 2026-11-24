/**
 * The provider port's cancellation (#869, desktop.md §Native provider and MCP calls): a call the writer stopped while the
 * key it needs was still being opened never reaches the provider, and the page hears that it was stopped rather than why
 * the key could not be opened.
 *
 * This lives beside the launched-app spec rather than inside it because the case needs a vault whose decryption is slow,
 * and the app's vault is the operating system's keychain: a runner has none, so no key can be stored there to open slowly.
 * The port's other rules are the repository's gate (`packages/gateway/test/native-egress.test.ts`), and what a page reaches
 * through the built app is `egress.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const fetched: string[] = [];
  return { handlers, fetched };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void => {
      shell.handlers.set(channel, handler);
    },
  },
  net: {
    fetch: async (url: string): Promise<Response> => {
      shell.fetched.push(url);
      return new Response('{}', { status: 200 });
    },
  },
}));

const { registerEgressIpc } = await import('../src/egress.mjs');

const ENTRY = 'caotang-app://studio/';
const KEY = 'prv_869';
const SECRET = 'sk-the-writer-saved-this-869';

type Listener = (...args: unknown[]) => void;

interface Page {
  readonly event: unknown;
  /** What the main process sent back to the page. */
  readonly sent: { channel: string; payload: unknown }[];
  /** Fires one of the page's own events, the way Electron would. */
  fire(event: string, ...args: unknown[]): void;
}

/** One page of the studio, as the handlers see it: an id, a channel to send on, and the events a document has. */
function page(): Page {
  const listeners = new Map<string, Listener[]>();
  const on = (event: string, listener: Listener): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const sent: { channel: string; payload: unknown }[] = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    once: on,
    on,
  };
  return {
    event: { sender, senderFrame: { parent: null, url: ENTRY } },
    sent,
    fire: (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
}

/** A value a test settles by hand: the key that is being opened, whose decryption takes as long as the case needs. */
function deferred<T>(): { promise: Promise<T>; settle(value: T): void; fail(error: unknown): void } {
  let settle: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; });
  return { promise, settle, fail };
}

/** Lets every microtask the handlers have queued run, and the turn with them. */
const settleTurn = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function handler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const found = shell.handlers.get(channel);
  if (found === undefined) throw new Error(`the port registered no ${channel} handler`);
  return found;
}

/** A vault holding one key, whose read is the case's own: this is the decryption the cancellation has to survive. */
function port(reading: () => Promise<{ apiKey: string }>): void {
  shell.handlers.clear();
  shell.fetched.length = 0;
  registerEgressIpc(ENTRY, { read: reading });
}

async function configure(studio: Page): Promise<void> {
  expect(await handler('net:configure')(studio.event, [{ origin: 'https://api.example.com', keys: [KEY] }]))
    .toEqual({ ok: true, value: null });
}

const start = (studio: Page, id: string): Promise<unknown> => handler('net:start')(studio.event, {
  id,
  url: 'https://api.example.com/v1/chat/completions',
  method: 'POST',
  headers: { authorization: `Bearer caotang-key:${KEY}` },
  body: '{}',
});

const abort = (studio: Page, id: string): Promise<unknown> => handler('net:abort')(studio.event, id);

describe('the port while a key is being opened', () => {
  it('sends nothing once the page has cancelled the call', async () => {
    const opening = deferred<{ apiKey: string }>();
    port(() => opening.promise);
    const studio = page();
    await configure(studio);

    const started = start(studio, 'cancel-during-the-read');
    await settleTurn();
    // A call whose head has not arrived yet is still a call the page may stop, and stopping one that never started is not an error.
    expect(await abort(studio, 'cancel-during-the-read')).toEqual({ ok: true, value: null });
    opening.settle({ apiKey: SECRET });

    expect(await started).toEqual({ ok: false, error: 'aborted' });
    expect(shell.fetched).toEqual([]);
  });

  it('answers with the cancellation when the key cannot be opened after it', async () => {
    const opening = deferred<{ apiKey: string }>();
    port(() => opening.promise);
    const studio = page();
    await configure(studio);

    const unhandled: unknown[] = [];
    const collect = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', collect);
    try {
      const started = start(studio, 'cancel-then-the-key-fails');
      await settleTurn();
      expect(await abort(studio, 'cancel-then-the-key-fails')).toEqual({ ok: true, value: null });
      opening.fail(new Error('the keychain would not open the key'));

      expect(await started).toEqual({ ok: false, error: 'aborted' });
      await settleTurn();
      expect(shell.fetched).toEqual([]);
      // A decryption nobody came back for is still a promise: it may not surface as a rejection the process has no handler for.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  });

  it('sends nothing when the document that asked is replaced while the key is being opened', async () => {
    const opening = deferred<{ apiKey: string }>();
    port(() => opening.promise);
    const studio = page();
    await configure(studio);

    const started = start(studio, 'reload-during-the-read');
    await settleTurn();
    studio.fire('did-start-navigation', {}, 'caotang-app://studio/next', false, true);
    opening.settle({ apiKey: SECRET });

    expect(await started).toEqual({ ok: false, error: 'aborted' });
    expect(shell.fetched).toEqual([]);
  });
});
