import type { ReactNode } from 'react';

export type PanelGlyphName = 'codex' | 'search' | 'check' | 'manuscript' | 'findings' | 'agent' | 'loading' | 'error' | 'trace';

export const PANEL_PATHS: Readonly<Record<PanelGlyphName, ReactNode>> = {
  codex: (<>
    <path d="M12 5v16" />
    <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />
  </>),
  search: (<>
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </>),
  check: (<>
    <path d="M20 6 9 17l-5-5" />
  </>),
  manuscript: (<>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>),
  findings: (<>
    <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
  </>),
  agent: (<>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  </>),
  loading: (<>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </>),
  error: (<>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </>),
  trace: (<>
    <path d="M8 5h13" />
    <path d="M13 12h8" />
    <path d="M13 19h8" />
    <path d="M3 10a2 2 0 0 0 2 2h3" />
    <path d="M3 5v12a2 2 0 0 0 2 2h3" />
  </>),
};

export function Glyph({ label, children }: { label?: string; children: ReactNode }): ReactNode {
  return (
    <svg
      className={label === undefined ? 'modern-icon' : 'modern-icon panel-status-glyph'}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PanelGlyph({ name, label }: { name: PanelGlyphName; label: string }): ReactNode {
  return <Glyph label={label}>{PANEL_PATHS[name]}</Glyph>;
}
