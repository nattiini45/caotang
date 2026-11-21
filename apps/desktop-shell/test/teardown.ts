/**
 * Ending a shell spec's application (#788). A spec that is finished with the app is not a writer being asked whether to keep their
 * words, but `electron.close()` goes through the window's unload, where the app's `beforeunload` guard asks exactly that question
 * whenever the session has not finished saving or a background task is still being drafted. Chromium raises the warning, the answer
 * races Playwright's own teardown of the page, and a warning answered with "stay" cancels the unload: the window stays up, the
 * application never quits, and the test spends its whole budget waiting for a close that cannot finish.
 *
 * Asking the main process to exit ends the app without an unload at all. An app that is already gone is nothing to end, and one that
 * will not go reports why within a bound of its own rather than as a test timeout.
 */

import type { ElectronApplication } from '@playwright/test';

/** How long the app is given to say whether it is still there. An answer is immediate, so this is only ever a stalled app. */
const PROBE_MS = 2_000;
/** How long it is given to go once the exit is asked for. An exit is immediate too, so this is only ever an app that will not go. */
const EXIT_MS = 8_000;

/**
 * Whether the app still answers. A closed one refuses everything Playwright asks of it, including anything that would tell us it is
 * closed, so the answer is found by asking it something harmless; an app that does not answer at all is left to the exit below, which
 * reports it.
 */
async function answers(electron: ElectronApplication): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), PROBE_MS); });
  const probe = Promise.resolve().then(() => electron.evaluate(() => true)).then(() => true, () => false);
  try {
    return await Promise.race([probe, stalled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Ends the application now, and resolves once it has gone. */
export async function closeShell(electron: ElectronApplication): Promise<void> {
  // A spec reaches its `finally` after whatever it was doing, and an app that ended on its own — the shell's own `fail()` exits that
  // way — has been gone for a while by then. There is nothing to end, and the failure that ended it is the one worth reporting.
  if (!await answers(electron)) return;
  /** What the exit request came to, or `null` while it has not answered: an app that exits answers by closing the connection. */
  let request: string | null = null;
  const closed = electron.waitForEvent('close', { timeout: EXIT_MS }).catch(() => {
    throw new Error(`The application did not exit within ${PROBE_MS + EXIT_MS} ms: ${request ?? 'the exit request never answered'}.`);
  });
  void electron.evaluate(({ app }) => app.exit(0)).catch((reason: unknown) => {
    request = `the exit request failed: ${reason instanceof Error ? reason.message : String(reason)}`;
  }).then(() => { request ??= 'the exit request was answered, but the application did not stop'; });
  await closed;
}
