/**
 * The import preview's reader Worker (issues #283 / #274 / #390). It hosts the readers the preview sources used to run on the main
 * thread, through the DOM-free session in reader-session.ts. It is a `'self'` module Worker (reader-host.ts makes it from a
 * same-origin URL), so the CSP's `worker-src 'self'` admits it and no `blob:` URL is involved. The readers need no DOM: they run here
 * exactly as they run in Node and on the main thread (e2e/import-read-worker.spec.ts, e2e/import-rtf-worker.spec.ts).
 *
 * The input bytes arrive once, on `open`, and are cached in the session; every read re-reads that copy. A read's picture bytes are
 * transferred back to the main thread, so an image-heavy RTF costs it no copy.
 */

import { resultTransferList, type ReaderOpen, type ReaderRead, type ReaderReply } from './reader-protocol.js';
import { createReaderSession } from './reader-session.js';

type Incoming = { readonly id: number } & (ReaderOpen | ReaderRead);

const scope = self as unknown as {
  location: { origin: string };
  onmessage: ((event: MessageEvent<Incoming>) => void) | null;
  postMessage(message: ReaderReply, transfer?: Transferable[]): void;
};

const handle = createReaderSession();

scope.onmessage = (event) => {
  // A dedicated worker hears only the page that made it; a message naming another origin is not the preview's.
  if (event.origin !== '' && event.origin !== scope.location.origin) return;
  const req = event.data;
  const id = req.id;
  void (async () => {
    try {
      const result = await handle(req);
      scope.postMessage({ id, ok: true, result }, resultTransferList(result));
    } catch (error) {
      scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
