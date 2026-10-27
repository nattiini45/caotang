/**
 * The gate in front of everything that compiles Ink (dialogue-narrative.md §2.2). The compiler is a separate download, so until it has
 * loaded `compileInk` throws; the children are not drawn until then, and the writer sees a status line, or the failure with Try again.
 * A project that holds a dialogue container has the compiler loaded before it opens (lifecycle.ts), so this is seen only when the
 * download is slow or fails, and for a container made in a project that had none.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { inkCompilerFailures, inkCompilerStatus, requestInkCompiler, subscribeInkCompiler, type InkCompilerStatus } from '../app/ink-compiler.js';

import { EmptyState } from './shared.js';

/** The load's status, starting the load when nothing has. A failed load is retried only by {@link requestInkCompiler}, never on its own. */
export function useInkCompiler(): InkCompilerStatus {
  const status = useSyncExternalStore(subscribeInkCompiler, inkCompilerStatus);
  useEffect(() => {
    if (inkCompilerStatus() === 'idle') void requestInkCompiler();
  }, []);
  return status;
}

export interface InkGateProps {
  /** `pane` fills the place a view goes. `inline` is one line, for a section of the Inspector. */
  readonly variant?: 'pane' | 'inline';
  readonly children?: ReactNode;
}

export function InkGate({ variant = 'pane', children }: InkGateProps): ReactNode {
  const status = useInkCompiler();
  if (status === 'ready') return children;
  if (status === 'failed') {
    // Some browsers keep a failed import for the life of the page, so a second failure sends the writer to Reload, which always fetches fresh.
    const retried = inkCompilerFailures() > 1;
    const title = retried ? t`The Ink compiler still could not be loaded` : t`The Ink compiler could not be loaded`;
    const body = retried
      ? t`Reload the page to fetch it again. Nothing in the project changed.`
      : t`This can happen after an update, or when the connection drops. Nothing in the project changed.`;
    const actions = (
      <>
        <button type="button" className="button" onClick={() => void requestInkCompiler()}>
          <Trans>Try again</Trans>
        </button>
        <button type="button" className={retried ? 'button is-primary' : 'button'} onClick={reloadPage}>
          <Trans>Reload</Trans>
        </button>
      </>
    );
    return variant === 'inline' ? (
      <div className="form-message is-error" role="alert">
        <p>
          {title}. {body}
        </p>
        {actions}
      </div>
    ) : (
      <div role="alert">
        <EmptyState title={title} actions={actions}>
          {body}
        </EmptyState>
      </div>
    );
  }
  const text = t`Loading the Ink compiler…`;
  return variant === 'inline' ? (
    <p className="field-note" role="status">
      {text}
    </p>
  ) : (
    <div className="empty-state" role="status">
      {text}
    </div>
  );
}

function reloadPage(): void {
  window.location.reload();
}
