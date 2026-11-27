/**
 * The Argon2id derivation, off the main thread — hosted.md §2, plan §4.4. The hash runs at m = 64 MiB, t = 3, p = 1,
 * which is a second or more on a phone; running it here keeps the passphrase panel painting its progress state and
 * lets the writer cancel a slow attempt without a frozen page. Only the derived key bytes cross the boundary, in one
 * transfer, and the passphrase arrives as bytes the main thread has already normalised.
 */
import { resolveArgon2idKdf, type KdfDescriptor } from '@caotang/crypto';

export interface DeriveRequest {
  readonly id: number;
  readonly descriptor: KdfDescriptor;
  readonly passphrase: Uint8Array;
  readonly salt: Uint8Array;
}

export type DeriveReply =
  | { readonly id: number; readonly ok: true; readonly bytes: Uint8Array }
  | { readonly id: number; readonly ok: false; readonly failure: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DeriveRequest>) => void) | null;
  postMessage: (message: DeriveReply, transfer?: Transferable[]) => void;
};

scope.onmessage = async (event: MessageEvent<DeriveRequest>) => {
  const { id, descriptor, passphrase, salt } = event.data;
  try {
    const bytes = await resolveArgon2idKdf(descriptor).derive(passphrase, salt);
    const reply: DeriveReply = { id, ok: true, bytes };
    scope.postMessage(reply, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    const reply: DeriveReply = { id, ok: false, failure: error instanceof Error ? error.message : 'derivation-failed' };
    scope.postMessage(reply);
  }
};
