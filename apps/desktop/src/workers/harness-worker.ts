
import { assembleProjected, computeScanWorker } from '@caotang/harness/worker';

import type { HarnessWorkerReply, HarnessWorkerRequest } from './harness-protocol.js';

self.onmessage = async ({ data }: MessageEvent<HarnessWorkerRequest>): Promise<void> => {
  const id = data.id;
  try {
    if (data.op !== 'assemble' && data.op !== 'scan') throw new Error('Invalid background operation.');
    if (data.op === 'assemble') {
      const call = assembleProjected(data.input, data.role, data.languages);
      self.postMessage({ id, ok: true, op: 'assemble', call } satisfies HarnessWorkerReply);
      return;
    }
    const outcome = await computeScanWorker(data.input);
    self.postMessage({ id, ok: true, op: 'scan', outcome } satisfies HarnessWorkerReply);
  } catch {
    self.postMessage({ id, ok: false, error: 'worker-failed' } satisfies HarnessWorkerReply);
  }
};
