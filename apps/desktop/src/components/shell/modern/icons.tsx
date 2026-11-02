/**
 * The ornaments' icons (modern-interface.md §8.1): inline SVG strokes in the text colour, decorative beside the words that name the
 * control (`aria-hidden`). No icon font and no file, so nothing is fetched and the CSP needs nothing.
 */

import type { ReactNode } from 'react';

export type IconName = 'write' | 'board' | 'codex' | 'ask' | 'search' | 'more' | 'check' | 'binder' | 'close' | 'manuscript' | 'pin';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  write: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  codex: (
    <>
      <path d="M5 4.5h10a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12z" />
      <path d="M5 16.5a3 3 0 0 1 3-3h10" />
    </>
  ),
  ask: (
    <>
      <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
      <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  // The narrow layout's binder button (#312): a panel at the start edge, and its close.
  binder: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15M5.5 8.5h2M5.5 11.5h2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // The binder bar's Manuscript (a page) and the sidebar's Keep open (a pin), #360.
  manuscript: <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5M10 15h5M10 18h3" />,
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
};

export function Icon({ name }: { name: IconName }): ReactNode {
  return (
    <svg className="modern-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
