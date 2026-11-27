import type { AccountBridge } from '../../../desktop-shell/src/account-contract.cjs';

export type { AccountBridge, AccountState } from '../../../desktop-shell/src/account-contract.cjs';

export const ACCOUNT_ORIGIN = window.location.origin;

export function bridge(window: Window): AccountBridge | undefined {
  return (window as Window & { caotangAccount?: AccountBridge }).caotangAccount;
}

export function createAccountFetch(native: AccountBridge): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const { signal } = request;
    const id = crypto.randomUUID();
    const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
    signal.throwIfAborted();
    const abort = () => native.abort(id);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await native.request({ id, url: request.url, method: request.method, headers: [...request.headers],
        ...(body === undefined ? {} : { body }),
      });
      signal.throwIfAborted();
      return new Response(result.body?.slice() ?? null, { status: result.status, headers: Object.fromEntries(result.headers) });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}
