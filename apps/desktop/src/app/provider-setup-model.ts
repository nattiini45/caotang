/**
 * The pure parts of adding a provider (provider-gateway §2, "Adding a provider"): what a failed check says to the person, and which
 * models the list shows. The markup is components/ProviderSetup.tsx; the key-to-profile steps are the ProviderService's.
 */

import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import type { ModelChoice } from '@caotang/gateway';

import type { SetupFailure } from './provider-setup.js';

/* lingui-set comment="Interpolated value: provider (a provider's name)" */

/** Models shown before "Show all": the recommended one, then the first few of the sorted list. */
export const COLLAPSED_MODEL_COUNT = 8;
/** A list this long gets a filter field. */
export const FILTER_MODEL_COUNT = 12;

export interface SetupFailureText {
  readonly text: string;
  /** The provider's own words or the connection guidance, kept apart from ours. */
  readonly detail?: { readonly label: string; readonly text: string };
  /** The failure is the endpoint not listing models, so a custom endpoint may type the model name instead. */
  readonly canTypeModel: boolean;
  /** The key field is where the person fixes it. */
  readonly aboutKey: boolean;
}

export function setupFailureText(providerName: string, failure: SetupFailure): SetupFailureText {
  const provider = isolate(providerName);
  if (failure.kind === 'invalid') return { text: failure.message, canTypeModel: false, aboutKey: failure.field === 'apiKey' };
  if (failure.kind === 'empty') {
    return { text: t`${provider} accepted the key but lists no models that write text. Check that the key belongs to a plan with model access.`, canTypeModel: true, aboutKey: false };
  }
  const { cause, providerReply, guidance } = failure.failure;
  const detail = providerReply !== undefined
    ? { label: t`Provider reply:`, text: providerReply }
    : guidance === undefined ? undefined : { label: t`Connection guidance:`, text: guidance };
  const base = (text: string, flags: { canTypeModel?: boolean; aboutKey?: boolean } = {}): SetupFailureText => ({
    text,
    canTypeModel: flags.canTypeModel === true,
    aboutKey: flags.aboutKey === true,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (cause) {
    case 'auth': return base(t`${provider} did not accept this key. Check that you copied all of it, then paste it again.`, { aboutKey: true });
    case 'unreadable': return base(t`${provider} did not answer the key check. This usually means the key was not accepted. Check it, then try again.`, { aboutKey: true });
    case 'network': return base(t`Could not reach ${provider}. Check your connection, then try again.`);
    case 'timeout': return base(t`${provider} did not answer in time. Try again in a moment.`);
    case 'rate-limit': return base(t`${provider} is limiting requests right now. Wait a moment, then try again.`);
    case 'models': return base(t`${provider} did not list its models.`, { canTypeModel: true });
    case 'provider': return base(t`${provider} could not answer the key check. Try again in a moment.`);
    case 'unknown': return base(t`The key could not be checked. Try again.`);
    default: return assertNeverCause(cause);
  }
}

function assertNeverCause(cause: never): never {
  throw new Error(`Unhandled probe failure: ${String(cause)}`);
}

/** The rows the list shows: all of them while a filter is typed or after "Show all", else the first few, with the chosen one kept in view. */
export function visibleModels(
  models: readonly ModelChoice[],
  query: string,
  showAll: boolean,
): { readonly shown: readonly ModelChoice[]; readonly hidden: number } {
  const needle = query.trim().toLowerCase();
  if (needle !== '') {
    const shown = models.filter((model) => model.id.toLowerCase().includes(needle));
    return { shown, hidden: 0 };
  }
  if (showAll || models.length <= COLLAPSED_MODEL_COUNT) return { shown: models, hidden: 0 };
  return { shown: models.slice(0, COLLAPSED_MODEL_COUNT), hidden: models.length - COLLAPSED_MODEL_COUNT };
}

/**
 * What the model list starts with: the recommended model, so a writer who presses the one finish button gets a working provider.
 * A provider that marks none recommended starts with nothing, and the finish button waits for a pick.
 */
export function defaultPick(models: readonly ModelChoice[]): readonly string[] {
  const recommended = models.find((model) => model.recommended);
  return recommended === undefined ? [] : [recommended.id];
}
