/**
 * The blocking notice for a stale tab: another tab has stored newer text for this project, so this tab cannot save (persistence.ts).
 *
 * The words typed here are still on screen. When this browser kept a copy of them (unsent-copy.ts), the notice says so, and a reload
 * keeps them: the project offers them back as new documents once it opens again. When it kept no copy, the words are in memory only,
 * and the notice says that instead. The notice cannot be dismissed, because the words must not be lost by carrying on as if they were
 * stored. The two ways on are the ones it names: export a backup of this tab's words, or reload this tab to carry on from the saved
 * text. A reload without a copy loses the words, so it is asked for twice: the first request says what the reload would lose, and
 * only the second one reloads. Nothing here writes to the project.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';

import { stopCause, subscribeStopCause } from '../app/integrity-model.js';
import { browserStorage, stopKeptInBrowser, subscribeStop } from '../app/unsent-copy.js';

export interface StaleTabNoticeProps {
  /** Makes the bundle of what this tab holds, the copy that keeps the words. */
  readonly onExport: () => void;
  /** Reloads the page, which carries on from what the browser stored. The words in this tab are kept here only when a copy was made. */
  readonly onReload: () => void;
}

export function StaleTabNotice({ onExport, onReload }: StaleTabNoticeProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Whether the writer has asked to reload, and is being told what that loses before the reload is offered.
  const [reloadAsked, setReloadAsked] = useState(false);
  // Whether this browser holds the words as of the latest change: read on every render, so a refused write is never shown as kept
  // (unsent-copy.ts stopKeptInBrowser). A copy an earlier stop left does not count.
  const kept = useSyncExternalStore(subscribeStop, () => stopKeptInBrowser(browserStorage()));
  // Why this tab stopped (integrity-model.ts `StopCause`): another tab stored newer text, or another tab upgraded Caotang's storage, which a reload of this
  // tab carries on from once the updated Caotang is the one this tab runs.
  const updated = useSyncExternalStore(subscribeStopCause, stopCause) === 'updated';

  // Shown as a modal from the start, so the page underneath cannot be used while the words are unsaved.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={titleId}
      data-testid="stale-tab-notice"
      data-kept={kept ? 'browser' : 'memory'}
      onCancel={(event) => {
        // Escape does not dismiss this one: the words are still only in this tab.
        event.preventDefault();
      }}
    >
      <form method="dialog" className="confirm-body">
        <h2 id={titleId}>
          {updated ? <Trans>Caotang was updated in another tab</Trans> : <Trans>This project is open in another tab</Trans>}
        </h2>
        <div className="confirm-text">
          {reloadAsked ? (
            kept ? (
              <>
                <p>
                  <Trans>
                    Reloading this tab keeps the words in this browser, where the project offers them back once it opens again. Nothing
                    already saved is overwritten.
                  </Trans>
                </p>
                <p><Trans>Export a backup too if you want a copy outside this browser.</Trans></p>
              </>
            ) : (
              <>
                <p>
                  <Trans>
                    Reloading this tab loses the latest words in it. They are on screen only, not in browser storage, so they cannot come
                    back after the reload.
                  </Trans>
                </p>
                <p><Trans>Export a backup to keep them first, or keep this tab.</Trans></p>
              </>
            )
          ) : (
            <>
              <p>
                {updated ? (
                  <Trans>
                    Caotang was updated in another tab, so this tab cannot save to browser storage. The words here are still on screen.
                  </Trans>
                ) : (
                  <Trans>Another tab has stored newer text for this project, so this tab cannot save. The words here are still on screen.</Trans>
                )}
              </p>
              {kept ? (
                <p>
                  {updated ? (
                    <Trans>
                      They are also kept in this browser, so the project can offer them back as new documents. Export a backup to keep a
                      copy outside this browser, then reload this tab to carry on with the updated Caotang.
                    </Trans>
                  ) : (
                    <Trans>
                      They are also kept in this browser, so the project can offer them back as new documents. Export a backup to keep a
                      copy outside this browser, then reload this tab to carry on from the saved text.
                    </Trans>
                  )}
                </p>
              ) : (
                <p>
                  {updated ? (
                    <Trans>
                      The latest words are not in browser storage. Export a backup to keep them, then reload this tab to carry on with the
                      updated Caotang.
                    </Trans>
                  ) : (
                    <Trans>
                      The latest words are not in browser storage. Export a backup to keep them, then reload this tab to carry on from the
                      saved text.
                    </Trans>
                  )}
                </p>
              )}
            </>
          )}
        </div>
        <div className="confirm-actions">
          {reloadAsked ? (
            <>
              <button type="button" className="button" autoFocus onClick={() => setReloadAsked(false)}>
                <Trans>Keep this tab</Trans>
              </button>
              {kept ? (
                <button type="button" className="button is-danger" onClick={onReload}>
                  <Trans>Reload and keep the words here</Trans>
                </button>
              ) : (
                <button type="button" className="button is-danger" onClick={onReload}>
                  <Trans>Reload and lose these words</Trans>
                </button>
              )}
              <button type="button" className="button is-primary" onClick={onExport}>
                <Trans>Export a backup</Trans>
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button" onClick={() => setReloadAsked(true)}>
                <Trans>Reload this tab</Trans>
              </button>
              <button type="button" className="button is-primary" autoFocus onClick={onExport}>
                <Trans>Export a backup</Trans>
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
