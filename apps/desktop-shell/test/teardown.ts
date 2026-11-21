/**
 * Ending a shell spec's application (#788). A spec that is finished with the app is not a writer being asked whether to keep their
 * words, but `electron.close()` goes through the window's unload, where the app's `beforeunload` guard asks exactly that question
 * whenever the session has not finished saving or a background task is still being drafted. Chromium raises the warning, the answer
 * races Playwright's own teardown of the page, and a warning answered with "stay" cancels the unload: the window stays up, the
 * application never quits, and the test spends its whole budget waiting for a close that cannot finish.
 *
 * Asking the main process to exit ends the app without an unload at all. The teardown waits on the process itself, so an app that has
 * already gone is nothing to wait for and an app that will not go reports why in seconds rather than as a test timeout.
 */

import type { ElectronApplication } from '@playwright/test';

/** How long the application is given to go once the exit is asked for: an exit is immediate, so this is only ever a failure path. */
const EXIT_MS = 10_000;

/** Ends the application now, and resolves once it has gone. */
export async function closeShell(electron: ElectronApplication): Promise<void> {
  const child = electron.process();
  // A spec whose app is already gone has nothing to end, and waiting for a close that has happened would replace whatever ended it
  // with a failure of this teardown's own making.
  if (child.exitCode !== null || child.signalCode !== null) return;
  /** What the exit request came to, or `null` while it has not answered: an app that exits usually answers by closing the connection. */
  let request: string | null = null;
  void electron.evaluate(({ app }) => app.exit(0)).then(
    () => { request = 'the exit request was answered, but the application did not stop'; },
    (reason: unknown) => { request = `the exit request failed: ${reason instanceof Error ? reason.message : String(reason)}`; },
  );
  const gone = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `The application did not exit within ${EXIT_MS} ms: ${request ?? 'the exit request never answered'}.`,
    )), EXIT_MS);
  });
  try {
    await Promise.race([gone, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
