/** Shared helpers for the SDK's tests: a temporary folder, and its removal. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `caotang-sdk-${label}-`));
}

/** Removes a folder the tests made. Retries cover Windows holding a file handle for a moment after close. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
