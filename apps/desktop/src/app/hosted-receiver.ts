import { setStorageScope } from './storage-scope.js';
import { setHostedProject, type HostedProjectSource } from './studio-host.js';

type ProjectIdentity = Pick<HostedProjectSource, 'projectId' | 'key'>;

export type HostedProjectHandoff = ProjectIdentity & (
  | { readonly mode: 'read'; readonly device?: never }
  | { readonly mode: 'edit'; readonly device: string }
);

interface ReceiverOptions {
  readonly origin: string;
  readonly root: HTMLElement;
  readonly language?: string;
  readonly bootEditor: (signal: AbortSignal) => void | Promise<void>;
}

type HandoffRefusal = 'invalid-project' | 'invalid-mode-or-device' | 'invalid-origin' | 'already-accepted' | 'invalid-account';

export class HostedHandoffError extends Error {
  constructor(readonly code: HandoffRefusal) {
    super(code);
    this.name = 'HostedHandoffError';
  }
}

const LABEL = /^[A-Za-z0-9_-]{1,64}$/;

function projectHandoff(value: unknown): HostedProjectHandoff {
  if (value === null || typeof value !== 'object') throw new HostedHandoffError('invalid-project');
  const { mode, projectId, key, device } = value as Record<string, unknown>;
  if (typeof projectId !== 'string' || !LABEL.test(projectId) ||
      !(key instanceof CryptoKey) || key.type !== 'secret' || key.extractable || key.algorithm.name !== 'HKDF' ||
      key.usages.length !== 1 || key.usages[0] !== 'deriveBits') {
    throw new HostedHandoffError('invalid-project');
  }
  if (mode === 'read' && device === undefined) return { mode, projectId, key };
  if (mode === 'edit' && typeof device === 'string' && LABEL.test(device)) return { mode, projectId, key, device };
  throw new HostedHandoffError('invalid-mode-or-device');
}

export function createHostedProjectReceiver({ origin, root, language, bootEditor }: ReceiverOptions) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new HostedHandoffError('invalid-origin');
  const controller = new AbortController();
  let accepted: HostedProjectHandoff['mode'] | undefined;
  let unmountReader: (() => void) | undefined;
  return {
    async receive(account: unknown, value: unknown): Promise<void> {
      controller.signal.throwIfAborted();
      if (accepted !== undefined) throw new HostedHandoffError('already-accepted');
      if (typeof account !== 'string' || !LABEL.test(account)) throw new HostedHandoffError('invalid-account');
      const project = projectHandoff(value);
      accepted = project.mode;
      if (project.mode === 'edit') {
        setStorageScope(account);
        setHostedProject({ origin, projectId: project.projectId, device: project.device, key: project.key });
        await bootEditor(controller.signal);
      } else {
        const { mountHostedReader } = await import('../hosted-reader/mount.js');
        controller.signal.throwIfAborted();
        unmountReader = mountHostedReader(root, { account, origin, project, language, signal: controller.signal });
      }
      controller.signal.throwIfAborted();
    },
    lock(): void {
      controller.abort();
      unmountReader?.();
      unmountReader = undefined;
      if (accepted === 'edit') setHostedProject(null);
    },
  };
}
