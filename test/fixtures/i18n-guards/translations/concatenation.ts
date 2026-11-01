import { t } from '@lingui/core/macro';

/** A message built by concatenation is refused (I8). */
export function greeting(name: string): string {
  return t`Hello ` + name;
}

export const greetingCall = (name: string): string => t('Hello ') + name;
