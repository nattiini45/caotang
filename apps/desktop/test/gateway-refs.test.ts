import { afterEach, beforeEach, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { ProviderError, ProfileError, providerMessages, providerRefs } from '@caotang/gateway';

import { gatewayText, probeFailureOf } from '../src/app/provider-probe.js';
import { renderRef, titleValues } from '../src/i18n/render-ref.js';
import { messages as en } from '../src/i18n/locales/en/messages.po';
import { messages as de } from '../src/i18n/locales/de/messages.po';

/**
 * #596: the gateway carries a MessageRef beside each fixed English message so the app can render the same
 * words in the interface language while logs, the SDK and the typed error keep the original bytes. An error
 * with no ref — provider- or host-supplied text — renders verbatim, never translated in place.
 */
beforeEach(() => {
  i18n.load('en', en);
  i18n.load('de', de);
});
afterEach(() => {
  i18n.activate('en');
});

it('renders a carried ref in the interface language, keeping the English .message untouched', () => {
  const error = new ProviderError('auth', providerMessages.auth('example.test'), { messageRef: providerRefs.auth('example.test') });
  i18n.activate('en');
  expect(gatewayText(error)).toBe('Key rejected by example.test. Check the profile in Settings.');
  i18n.activate('de');
  expect(gatewayText(error)).toBe('Der Schlüssel wurde von example.test abgelehnt. Prüfen Sie das Profil in den Einstellungen.');
  expect(error.message).toBe('Key rejected by example.test. Check the profile in Settings.');
});

it('renders interpolated values in the interface language', () => {
  i18n.activate('de');
  const error = new ProviderError('endpoint', providerMessages.endpoint('/v1/chat', 'https://x.test/v1'), {
    messageRef: providerRefs.endpoint('/v1/chat', 'https://x.test/v1'),
  });
  expect(gatewayText(error)).toBe('Kein /v1/chat unter https://x.test/v1. Die meisten OpenAI-kompatiblen Basis-URLs enden auf /v1.');
});

it('leaves an error with no ref — provider- or host-supplied text — exactly as thrown', () => {
  i18n.activate('de');
  const raw = 'Some provider said no in its own words';
  expect(gatewayText(new ProviderError('provider', raw))).toBe(raw);
  expect(gatewayText(new ProfileError('invalid', 'A host-supplied validation string'))).toBe('A host-supplied validation string');
});

it('carries the profile-not-found ref on ProfileError', () => {
  i18n.activate('de');
  const error = new ProfileError('not-found', 'No provider profile has the id abc.', { messageRef: providerRefs.notFound('abc') });
  expect(gatewayText(error)).toBe('Kein Anbieter-Profil hat die ID abc.');
});

it('puts the local refusal guidance through the catalogue for probe failures', () => {
  i18n.activate('de');
  const message = providerMessages.localRefused('Ollama', '127.0.0.1:11434');
  const error = new ProviderError('network', message, { permanent: true, messageRef: providerRefs.localRefused('Ollama', '127.0.0.1:11434') });
  expect(probeFailureOf(error).guidance).toBe('Auf 127.0.0.1:11434 lauscht nichts. Läuft Ollama? Starten Sie es, oder korrigieren Sie die Adresse in den Einstellungen.');
});

it('keeps user-supplied values in the values map for titleValues isolation', () => {
  const ref = providerRefs.missingKey('My profile');
  expect(titleValues(ref)).toEqual(['name']);
  i18n.activate('de');
  // `name` is writer content: renderRef isolates it once (FSI…PDI) before formatting.
  expect(renderRef(ref, { userValues: titleValues(ref) })).toBe('Der für „⁨My profile⁩“ gespeicherte Schlüssel kann auf diesem Gerät nicht gelesen werden. Geben Sie ihn in den Einstellungen erneut ein.');
});
