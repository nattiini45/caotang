/**
 * The Lingui provider the app renders under (i18n.md §3.2). `i18n` is the module singleton the entry
 * activates ([runtime.ts](./runtime.ts)); wrapping the app once means `useLingui`/`<Trans>` see the
 * same catalogue everywhere, and a later `activate()` re-renders without a reload (§3.3).
 */
import { I18nProvider as LinguiI18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import type { ReactNode } from 'react';

export function I18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
  return <LinguiI18nProvider i18n={i18n}>{children}</LinguiI18nProvider>;
}
