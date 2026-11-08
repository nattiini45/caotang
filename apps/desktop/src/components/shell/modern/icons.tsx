import type { ReactNode } from 'react';

import { Glyph, PANEL_PATHS } from '../../panel-glyph.js';

export type IconName = 'write' | 'board' | 'codex' | 'pictures' | 'ask' | 'search' | 'more' | 'check' | 'binder' | 'close' | 'manuscript' | 'scene' | 'plus' | 'findings' | 'agent' | 'pin' | 'loading' | 'error' | 'trace' | 'screenplay' | 'comic' | 'timeline';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  ...PANEL_PATHS,
  write: (<>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </>),
  board: (<>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 21V9" />
  </>),
  pictures: (<>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </>),
  ask: (<>
    <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
  </>),
  more: (<>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>),
  binder: (<>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
  </>),
  close: (<>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>),
  scene: (<>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  </>),
  plus: (<>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>),
  pin: (<>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </>),
  screenplay: <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 11h5M11 14h3M9 17h7" />,
  comic: <path d="M4 4h16v16H4zM4 11h16M12 4v7M10 11v9" />,
  timeline: <path d="M4 7h9M8 12h12M4 17h7" />,
};

export function Icon({ name, label }: { name: IconName; label?: string }): ReactNode {
  return <Glyph label={label}>{PATHS[name]}</Glyph>;
}
