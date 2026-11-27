/**
 * The main thread's side of {@link kdf-worker}: a {@link Kdf} the crypto package derives through, so an unlock builds
 * the same KEK it would build inline while the work happens off the thread. The worker starts on the first derivation
 * and is reused; the hash-wasm WASM therefore still enters only on setup, unlock and recovery.
 */
import { CryptoError, type Kdf, type KdfDescriptor } from '@caotang/crypto';
import type { DeriveReply, DeriveRequest } from './kdf-worker.js';

export interface WorkerKdf {
  /** The Kdf that derives this record's descriptor in the worker. */
  resolve(descriptor: KdfDescriptor): Kdf;
  /** Terminates the worker; the next derivation starts a fresh one. */
  close(): void;
}

interface Pending {
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

export function workerKdf(): WorkerKdf {
  let worker: Worker | null = null;
  let next = 0;
  const pending = new Map<number, Pending>();

  const receive = (event: MessageEvent<DeriveReply>): void => {
    const reply = event.data;
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.bytes);
    else waiting.reject(new CryptoError('invalid-argument', reply.failure));
  };

  const open = (): Worker => {
    if (worker) return worker;
    const started = new Worker(new URL('./kdf-worker.ts', import.meta.url), { type: 'module', name: 'caotang-unlock' });
    started.addEventListener('message', receive);
    started.addEventListener('error', () => {
      for (const waiting of pending.values()) waiting.reject(new Error('The derivation worker stopped.'));
      pending.clear();
      started.terminate();
      if (worker === started) worker = null;
    });
    worker = started;
    return started;
  };

  return {
    resolve(descriptor: KdfDescriptor): Kdf {
      return {
        id: descriptor.id,
        derive(passphrase: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
          const id = next++;
          // Copies, because a transferred buffer is detached in the sender: the crypto package reads the salt again
          // after deriving (it lands in the record the server stores), so handing the caller's own buffers to the
          // worker would leave that record with an empty salt.
          const request: DeriveRequest = { id, descriptor, passphrase: passphrase.slice(), salt: salt.slice() };
          return new Promise<Uint8Array>((resolveDerived, rejectDerived) => {
            pending.set(id, { resolve: resolveDerived, reject: rejectDerived });
            try {
              open().postMessage(request, [request.passphrase.buffer as ArrayBuffer, request.salt.buffer as ArrayBuffer]);
            } catch (error) {
              pending.delete(id);
              rejectDerived(error instanceof Error ? error : new Error('The derivation could not start.'));
            }
          });
        },
      };
    },
    close(): void {
      worker?.terminate();
      worker = null;
      for (const waiting of pending.values()) waiting.reject(new Error('The derivation was cancelled.'));
      pending.clear();
    },
  };
}
