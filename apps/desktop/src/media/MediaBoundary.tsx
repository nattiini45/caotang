/**
 * The error boundary every media view is wrapped in. A view that throws while it draws (a stored value the views did not
 * expect, for example) shows the fallback in its place. Without one, a single bad node unmounts the React root and the
 * whole app goes blank. `mediaViewFor` wraps each view here, so the App needs no wrapper of its own.
 */

import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { Trans } from '@lingui/react/macro';
import { Component, type ReactNode } from 'react';

import { EmptyState } from '../components/shared.js';


/* lingui-set comment="A media view that failed to draw. Interpolated values: title is the item's title." */
export interface MediaBoundaryProps {
  /** The node's title, so the fallback names what could not be drawn. */
  readonly title: string;
  readonly children?: ReactNode;
}

interface MediaBoundaryState {
  readonly failed: boolean;
}

export class MediaBoundary extends Component<MediaBoundaryProps, MediaBoundaryState> {
  override state: MediaBoundaryState = { failed: false };

  static getDerivedStateFromError(): MediaBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState title={t`${{ title: isolate(this.props.title) }} could not be drawn`}>
        <Trans>Nothing in the project changed, and the rest of the app is still open. Choose another item to leave this one.</Trans>
      </EmptyState>
    );
  }
}
