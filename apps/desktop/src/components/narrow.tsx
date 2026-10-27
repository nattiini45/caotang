/**
 * The narrow layout's two shared pieces: the hook that says whether the window is narrow, and the notice a desktop-only view shows in
 * its place (ui-modules §0.6). The query is the one styles.css repeats, so the rules and the markup change at the same width.
 */

import { useSyncExternalStore, type ReactNode } from 'react';

import { DESKTOP_FEATURES, NARROW_MAX_WIDTH, NARROW_QUERY, type DesktopFeature } from '../app/narrow-model.js';

function list(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const query = list();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

/** Whether the window is narrower than the desktop shell; it follows a resize or a rotation. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => list()?.matches ?? false, () => false);
}

/**
 * What a narrow window shows for a view it does not draw: the feature in words, what is unchanged, and how to reach it. It is
 * a region of its own, so a screen reader lands on it, and it never fails silently or half-works.
 */
export function OpenOnDesktop({
  feature,
  actions,
}: {
  feature: DesktopFeature;
  /** A way back to something that works here (the editor), when the view has one. */
  actions?: ReactNode;
}): ReactNode {
  const note = DESKTOP_FEATURES[feature];
  return (
    <section className="empty-state open-on-desktop" aria-label={`Open on desktop: ${note.name}`} data-testid="open-on-desktop" data-feature={feature}>
      <h2>Open on desktop: {note.name}</h2>
      <div className="empty-text">
        <p>{note.detail}</p>
        <p className="muted">
          This window is narrower than {NARROW_MAX_WIDTH + 1} px. Open Caotang on a desktop, or in a wider window, to use it.
        </p>
      </div>
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </section>
  );
}
