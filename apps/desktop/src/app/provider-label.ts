/**
 * The provider's name as the agent panel shows it. The built-in profile is named "Demo (no key)", which already says it is a
 * demo, so the panel adds "(demo)" only for a demo profile whose name does not say so. A writer who renamed it still sees the
 * mark once, and nobody sees it twice.
 */
import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';

/* lingui-set comment="Interpolated values: name" */
export function providerLabel(name: string, isDemo: boolean): string {
  if (!isDemo) return name;
  return /\bdemo\b/i.test(name) ? name : t`${{ name: isolate(name) }} (demo)`;
}
