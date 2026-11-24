/**
 * The page's side of the provider port (#869, desktop.md §Native provider and MCP calls): a call the writer stopped is
 * answered as stopped, and a stopped call never reaches the main process at all.
 *
 * What the main process does with a cancellation that arrives while a key is being opened is the shell's own check
 * (`apps/desktop-shell/test/egress-cancel.test.ts`); this holds what the page promises the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EgressHead, EgressReply, NativeEgressBridge } from '../../desktop-shell/src/egress-contract.cjs';
import type { DesktopEgress } from '../src/app/native-egress.js';
import { desktopEgress } from '../src/app/native-egress.js';

const ORIGIN = 'https://api.example.com';
const URL_UNDER_TEST = `${ORIGIN}/v1/chat/completions`;
const HEAD: EgressReply<EgressHead> = { ok: true, value: { status: 200, statusText: '', headers: {} } };

function withBridge(net: Partial<NativeEgressBridge>): void {
  (globalThis as { window?: unknown }).window = {
    caotangDesktop: {
      version: 4,
      net: {
        configure: async () => ({ ok: true, value: null }),
        start: async () => HEAD,
        abort: async () => ({ ok: true, value: null }),
        onChunk: () => () => undefined,
        onEnd: () => () => undefined,
        ...net,
      },
    },
  };
}

/** The port the page would use, with one address to reach and one key it may carry. */
function port(net: Partial<NativeEgressBridge>): DesktopEgress {
  withBridge(net);
  const egress = desktopEgress();
  if (egress === undefined) throw new Error('the page has no port');
  egress.points(() => [{ origin: ORIGIN, keys: ['prv_869'] }]);
  return egress;
}

const call = (egress: DesktopEgress, signal: AbortSignal): Promise<Response> =>
  egress.fetch(URL_UNDER_TEST, { method: 'POST', body: '{}', signal });

afterEach(() => {
  (globalThis as { window?: unknown }).window = undefined;
  vi.restoreAllMocks();
});

describe('a call the writer stopped', () => {
  it('is never sent when it was stopped before it started', async () => {
    const start = vi.fn(async () => HEAD);
    const egress = port({ start });
    const controller = new AbortController();
    controller.abort();

    await expect(call(egress, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
  });

  it('is reported as stopped, not as whatever failed after the stop', async () => {
    let answer: (reply: EgressReply<EgressHead>) => void = () => undefined;
    const start = vi.fn(() => new Promise<EgressReply<EgressHead>>((resolve) => { answer = resolve; }));
    const abort = vi.fn(async () => ({ ok: true, value: null }));
    const egress = port({ start, abort });
    const controller = new AbortController();

    const stopped = call(egress, controller.signal);
    await vi.waitFor(() => { expect(start).toHaveBeenCalled(); });
    controller.abort();
    await vi.waitFor(() => { expect(abort).toHaveBeenCalled(); });
    // The main process had already given up on the call — the key it needed would not open — before the stop reached it.
    answer({ ok: false, error: 'denied' });

    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
  });
});
