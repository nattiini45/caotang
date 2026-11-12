import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { assertNever } from '@caotang/machine';
import type { ProbeFailure } from '../app/provider-probe.js';

/* lingui-set comment="Interpolated value: profile (the writer's provider profile name)" */

export function probeFailureMessage(name: string, failure?: ProbeFailure): {
  readonly text: string;
  readonly detail?: { readonly label: string; readonly text: string };
} {
  const profile = isolate(name);
  const cause = failure?.cause ?? 'unknown';
  let text: string;
  switch (cause) {
    case 'auth': text = t`“${profile}” is saved but not verified: The provider rejected the key.`; break;
    case 'models': text = t`“${profile}” is saved but not verified: The provider did not list its models.`; break;
    case 'network': text = t`“${profile}” is saved but not verified: The provider could not be reached from this page.`; break;
    case 'timeout': text = t`“${profile}” is saved but not verified: The provider did not answer in time.`; break;
    case 'unreadable': text = t`“${profile}” is saved but not verified: The browser did not let this page read the model list. Chat may still work.`; break;
    case 'rate-limit': text = t`“${profile}” is saved but not verified: The provider is limiting requests. Wait a moment and save it again.`; break;
    case 'provider': text = t`“${profile}” is saved but not verified: The provider could not answer the model-list request.`; break;
    case 'unknown': text = t`“${profile}” is saved but not verified: The model list could not be checked.`; break;
    default: return assertNever(cause);
  }
  return {
    text,
    ...(failure?.providerReply !== undefined
      ? { detail: { label: t`Provider reply:`, text: failure.providerReply } }
      : failure?.guidance === undefined ? {} : { detail: { label: t`Connection guidance:`, text: failure.guidance } }),
  };
}
