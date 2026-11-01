/**
 * The Settings dialog, loaded when it is first opened. Home and the workspace both open it, and it carries every section's form (the
 * providers, MCP & tools, the context budgets), none of which a first screen needs. While the code arrives a status line says so, and a
 * load that fails is a sentence with Try again, Reload and Close (lazy-view.tsx), so a click on Settings is never answered with nothing.
 */

import type { ReactNode } from 'react';
import { t } from '@lingui/core/macro';

import { LazyBoundary, lazyView } from './lazy-view.js';
import type { SettingsProps } from './Settings.js';

export type { SettingsSection } from './Settings.js';

const SettingsDialog = lazyView(() => import('./Settings.js').then((module) => ({ default: module.Settings })));

export function Settings(props: SettingsProps): ReactNode {
  return (
    <LazyBoundary label={t`Settings`} variant="toast" onDismiss={props.onClose}>
      <SettingsDialog {...props} />
    </LazyBoundary>
  );
}
