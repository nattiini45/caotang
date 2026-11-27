import type { HostedProjectHandoff } from '../app/hosted-receiver.js';
import { createHostedProjectReceiver } from '../app/hosted-receiver.js';
import { hostedTargetFor } from '../app/hosted-target-registry.js';
import { ACCOUNT_ORIGIN, bridge, createAccountFetch } from './transport.js';
import de from './copy.de.json';
import en from './copy.en.json';
import './studio.css';

export interface AccountStudioHandoff {
  readonly kind: 'account-project';
  readonly origin: string;
  readonly account: string;
  readonly scope: string;
  readonly language: string;
  readonly project: HostedProjectHandoff;
}

export type AccountStudioWindow = Window & { closeAccountProject?: () => Promise<boolean> };
export type AccountHostWindow = Window & { renewAccountLease?: () => Promise<boolean> };

let receiver: ReturnType<typeof createHostedProjectReceiver> | undefined;
let editing: string | undefined;
let closing = false;
const parentWindow = window.parent;
const root = document.getElementById('root');
if (root && parentWindow !== window && parentWindow.location.origin === ACCOUNT_ORIGIN && parentWindow.location.pathname === '/account/index.html') {
  const native = bridge(parentWindow);
  const mount = parentWindow.document.getElementById('account-recovery-actions');
  if (native) {
    (window as AccountStudioWindow).closeAccountProject = async () => {
      if (closing) return false;
      closing = true;
      root.inert = true;
      if (mount) mount.inert = true;
      const target = editing === undefined ? null : hostedTargetFor(editing);
      if (target && !await target.canLeave()) {
        root.inert = false;
        if (mount) mount.inert = false;
        closing = false;
        return false;
      }
      receiver?.lock();
      return true;
    };
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== parentWindow || event.origin !== ACCOUNT_ORIGIN) return;
      if (closing || receiver || event.data === null || typeof event.data !== 'object') return;
      const handoff = event.data as Partial<AccountStudioHandoff>;
      if (handoff.kind !== 'account-project' || typeof handoff.origin !== 'string' || typeof handoff.account !== 'string' ||
        typeof handoff.scope !== 'string' || typeof handoff.language !== 'string') return;
      const account = handoff.account;
      const fetchAccount = createAccountFetch(native);
      const recoveryCopy = handoff.language === 'de' ? de : en;
      try {
        receiver = createHostedProjectReceiver({ origin: handoff.origin, language: handoff.language, scope: handoff.scope, root,
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Caotang-Account', account);
            return fetchAccount(input, { ...init, headers });
          },
          beforeExplicitSend: async () => await (parentWindow as AccountHostWindow).renewAccountLease?.() ?? false,
          ...(mount ? { desktopRecovery: { mount, warning: recoveryCopy.closeRefused, send: recoveryCopy.send,
            exportBundle: recoveryCopy.exportBundle, exportFailed: recoveryCopy.exportFailed } } : {}),
          bootEditor: async (signal) => { signal.throwIfAborted(); await import('../main.js'); },
        });
        if (handoff.project?.mode === 'edit') editing = handoff.project.projectId;
        void receiver.receive(handoff.account, handoff.project).catch(() => parentWindow.postMessage('account-project-failed', ACCOUNT_ORIGIN));
      } catch {
        parentWindow.postMessage('account-project-failed', ACCOUNT_ORIGIN);
      }
    });
  }
}
