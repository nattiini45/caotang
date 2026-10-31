/**
 * A module Worker for `import-rtf-worker.spec.ts`: it imports the RTF reader from the dev server, exactly as an importer's own
 * `'self'` Worker will, runs it on what the page sends, and posts back what it read. It is not part of the app; the dev server serves
 * it under `/@fs/`, same origin as the page, so the page's `worker-src 'self'` admits it.
 */

import { readRtf } from '../packages/import-rtf/src/rtf.js';

import { rtfSummary, type RtfInput } from './import-rtf-summary.js';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RtfInput>) => void) | null;
  postMessage(message: unknown): void;
  addEventListener(type: 'securitypolicyviolation', listener: (event: SecurityPolicyViolationEvent) => void): void;
};

const violations: string[] = [];
scope.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.effectiveDirective} refused ${event.blockedURI || '(inline)'}`);
});

scope.onmessage = (event) => {
  try {
    const summary = rtfSummary(event.data, readRtf);
    scope.postMessage({ summary, violations, isWorker: typeof (self as { document?: unknown }).document === 'undefined' });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
