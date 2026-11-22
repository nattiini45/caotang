import { Miniflare } from 'miniflare';
import type { MiniflareOptions } from 'miniflare';
import { afterAll, afterEach, beforeAll } from 'vitest';

interface ClosableSocket {
  close(): void;
  terminate?(): void;
}

/**
 * One Miniflare Worker runtime for the whole suite file, re-deployed per case through `set()` instead of a fresh
 * `new Miniflare` per case — the per-case boot is what timed these suites out on Windows (#815, #820). The caller's
 * option builder gives every case its own database names and Durable Object `unsafeUniqueKey`s, so state does not
 * carry between cases. A case that needs two differently-configured runtimes at once gets a real extra Miniflare for
 * every call after the first, disposed at the end of the case.
 *
 * Three catches the pattern carries: `setOptions` replaces the whole configuration rather than merging, so the option
 * builder must return complete options each call; `setOptions` can rebind the loopback listener, so `address` is
 * re-read after every `set()`; and runtime-object stubs (D1, R2, DO namespaces) are poisoned by a re-deploy, so every
 * case fetches its stubs after its `set()`.
 */
export function sharedRuntime(build: () => MiniflareOptions) {
  let instance: Miniflare | undefined;
  let address: string | undefined;
  let usedInCase = false;
  const extras: Miniflare[] = [];
  const sockets = new Set<ClosableSocket>();

  beforeAll(async () => {
    instance = new Miniflare(build());
    address = String(await instance.ready);
  }, 60_000);

  afterAll(async () => {
    await instance?.dispose();
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.terminate) socket.terminate();
      else socket.close();
    }
    sockets.clear();
    usedInCase = false;
    await Promise.all(extras.splice(0).map((extra) => extra.dispose()));
  });

  const setShared = async (options: MiniflareOptions): Promise<Miniflare> => {
    await instance!.setOptions(options);
    address = String(await instance!.ready);
    return instance!;
  };
  const set = async (options: MiniflareOptions): Promise<Miniflare> => {
    if (!usedInCase) {
      usedInCase = true;
      return setShared(options);
    }
    const extra = new Miniflare(options);
    extras.push(extra);
    address = String(await extra.ready);
    return extra;
  };
  const track = <T extends ClosableSocket>(socket: T): T => {
    sockets.add(socket);
    return socket;
  };
  return {
    get instance() {
      return instance!;
    },
    get address() {
      return address!;
    },
    set,
    setShared,
    track,
  };
}
