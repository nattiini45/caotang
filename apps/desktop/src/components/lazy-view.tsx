/**
 * Views that load when they are first opened, and what the writer sees while they load or when they cannot.
 *
 * `lazyView` is `React.lazy` with a way back from a failed load: a chunk that cannot be fetched (the connection dropped, or the tab
 * is older than the deploy that renamed the file, which a build with no service worker cannot serve) rejects once, and React.lazy
 * remembers the rejection. A failed view is therefore made again, from the same import, the next time it is mounted.
 *
 * `LazyBoundary` is the one place that says it. It shows a status line while the code arrives, and a plain sentence with Try again and
 * Reload when it does not. Chromium keeps a failed import for the life of the page, so Try again can fail the same way there; the
 * second failure says so and makes Reload the main button. It only takes a failed *load*; any other error goes on to the next boundary
 * up (MediaBoundary, for a view that throws while it draws). There is no automatic reload: that would discard the page's state
 * without being asked.
 */
/* lingui-set comment="Interpolated values: subject" */

import { Component, Suspense, createElement, lazy, useState, type ComponentType, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { EmptyState } from './shared.js';

/** The import of a view's code failed. The view's own errors are not this. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ChunkLoadError';
  }
}

/**
 * A component that loads `load()` on first render. Render it inside a {@link LazyBoundary}. It takes the props the loaded component takes.
 * A view whose load failed is made again each time it is mounted afresh, which is what Try again does and what going back to the item does.
 */
export function lazyView<C extends ComponentType<never>>(load: () => Promise<{ readonly default: C }>): C {
  let failed = false;
  const fetchView = (): Promise<{ readonly default: ComponentType<object> }> => (load() as unknown as Promise<{ readonly default: ComponentType<object> }>).catch((error: unknown) => {
    failed = true;
    throw new ChunkLoadError(error);
  });
  let View = lazy(fetchView);
  const LazyView = (props: object): ReactNode => {
    useState(() => {
      if (!failed) return;
      failed = false;
      View = lazy(fetchView);
    });
    return createElement(View, props);
  };
  return LazyView as unknown as C;
}

export interface LazyBoundaryProps {
  /** What is loading, in the words a sentence about it uses: "the storyboard", "Settings". */
  readonly label: string;
  /** `pane` fills the place the view goes. `toast` is the status line at the bottom, for a dialog that opens over the page. */
  readonly variant?: 'pane' | 'toast';
  /** For a `toast`: closes the thing that was being opened, so a failed load leaves nothing behind. */
  readonly onDismiss?: () => void;
  readonly children?: ReactNode;
}

interface LazyBoundaryState {
  readonly error: unknown;
  /** How many times Try again has been pressed. */
  readonly tries: number;
}

const NO_ERROR: unique symbol = Symbol('no error');

export class LazyBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  override state: LazyBoundaryState = { error: NO_ERROR, tries: 0 };

  static getDerivedStateFromError(error: unknown): Pick<LazyBoundaryState, 'error'> {
    return { error };
  }

  override render(): ReactNode {
    const { label, variant = 'pane', onDismiss, children } = this.props;
    const { error, tries } = this.state;
    if (error === NO_ERROR) {
      return <Suspense fallback={<LoadingLine label={label} variant={variant} />}>{children}</Suspense>;
    }
    // Not a failed load: this boundary has nothing to say about it, so it goes to the next one.
    if (!(error instanceof ChunkLoadError)) throw error;
    // Some browsers keep a failed import for the life of the page, so a second failure sends the writer to Reload, which always fetches fresh.
    const retried = tries > 0;
    const actions = (
      <>
        <button type="button" className="button" onClick={this.tryAgain}>
          <Trans>Try again</Trans>
        </button>
        <button type="button" className={retried ? 'button is-primary' : 'button'} onClick={reloadPage}>
          <Trans>Reload</Trans>
        </button>
        {onDismiss === undefined ? null : (
          <button type="button" className="button is-quiet" onClick={onDismiss}>
            <Trans>Close</Trans>
          </button>
        )}
      </>
    );
    const subject = capitalised(label);
    const title = retried ? t`${{ subject }} still could not be loaded` : t`${{ subject }} could not be loaded`;
    const reason = retried ? t`Reload the page to fetch it again.` : t`This can happen after an update, or when the connection drops.`;
    if (variant === 'toast') {
      return (
        <div className="status-line is-error" role="alert">
          <span>
            {title}. {reason}
          </span>
          {actions}
        </div>
      );
    }
    return (
      <div role="alert">
        <EmptyState title={title} actions={actions}>
          {reason} <Trans>Nothing in the project changed.</Trans>
        </EmptyState>
      </div>
    );
  }

  private readonly tryAgain = (): void => {
    this.setState((state) => ({ error: NO_ERROR, tries: state.tries + 1 }));
  };
}

function LoadingLine({ label, variant }: { readonly label: string; readonly variant: 'pane' | 'toast' }): ReactNode {
  const text = t`Loading ${{ subject: label }}…`;
  return variant === 'toast' ? (
    <p className="status-line" role="status">
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

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
