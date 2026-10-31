/**
 * A module Worker for `import-read-worker.spec.ts`: it imports the shared import readers from the dev server, exactly as an
 * importer's own `'self'` Worker will, runs them on what the page sends, and posts back what they read. It is not part of the
 * app; the dev server serves it under `/@fs/`, same origin as the page, so the page's `worker-src 'self'` admits it.
 */

import { attr, descendants, readXml, textOf } from '../packages/import-read/src/xml.js';
import { openZip } from '../packages/import-read/src/zip.js';

import { readersSummary, type ReadersInput } from './import-read-summary.js';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ReadersInput>) => void) | null;
  postMessage(message: unknown): void;
  addEventListener(type: 'securitypolicyviolation', listener: (event: SecurityPolicyViolationEvent) => void): void;
};

const violations: string[] = [];
scope.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.effectiveDirective} refused ${event.blockedURI || '(inline)'}`);
});

scope.onmessage = (event) => {
  void readersSummary(event.data, { readXml, descendants, attr, textOf, openZip }).then(
    (summary) => scope.postMessage({ summary, violations, isWorker: typeof (self as { document?: unknown }).document === 'undefined' }),
    (error: unknown) => scope.postMessage({ error: String(error) }),
  );
};
