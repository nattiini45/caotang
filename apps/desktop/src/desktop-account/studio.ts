import type { HostedProjectHandoff } from '../app/hosted-receiver.js';
import { createHostedProjectReceiver } from '../app/hosted-receiver.js';
import { ACCOUNT_ORIGIN, bridge, createAccountFetch } from './transport.js';

export interface AccountStudioHandoff {
  readonly kind: 'account-project';
  readonly origin: string;
  readonly account: string;
  readonly scope: string;
  readonly language: string;
  readonly project: HostedProjectHandoff;
}

let receiver: ReturnType<typeof createHostedProjectReceiver> | undefined;
const parentWindow = window.parent;
const root = document.getElementById('root');
if (root && parentWindow !== window && parentWindow.location.origin === ACCOUNT_ORIGIN && parentWindow.location.pathname === '/account/index.html') {
  const native = bridge(parentWindow);
  if (native) {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== parentWindow || event.origin !== ACCOUNT_ORIGIN) return;
      if (event.data === 'lock-account-project') {
        receiver?.lock();
        return;
      }
      if (receiver || event.data === null || typeof event.data !== 'object') return;
      const handoff = event.data as Partial<AccountStudioHandoff>;
      if (handoff.kind !== 'account-project' || typeof handoff.origin !== 'string' || typeof handoff.account !== 'string' ||
        typeof handoff.scope !== 'string' || typeof handoff.language !== 'string') return;
      const account = handoff.account;
      const fetchAccount = createAccountFetch(native);
      try {
        receiver = createHostedProjectReceiver({ origin: handoff.origin, language: handoff.language, scope: handoff.scope, root,
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Caotang-Account', account);
            return fetchAccount(input, { ...init, headers });
          },
          bootEditor: async (signal) => { signal.throwIfAborted(); await import('../main.js'); },
        });
        void receiver.receive(handoff.account, handoff.project).catch(() => parentWindow.postMessage('account-project-failed', ACCOUNT_ORIGIN));
      } catch {
        parentWindow.postMessage('account-project-failed', ACCOUNT_ORIGIN);
      }
    });
  }
}
