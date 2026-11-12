import { afterEach, describe, expect, it } from 'vitest';
import { isolate } from '@caotang/i18n';
import { ProviderError } from '@caotang/gateway';
import { probeFailureOf, type ProbeFailure } from '../src/app/provider-probe.js';
import { probeFailureMessage } from '../src/components/provider-probe-message.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => { activateEnglish(); });

const causes: { cause: ProbeFailure['cause']; en: string; de: string }[] = [
  { cause: 'auth', en: 'The provider rejected the key.', de: 'Der Anbieter hat den Schlüssel abgelehnt.' },
  { cause: 'models', en: 'The provider did not list its models.', de: 'Der Anbieter hat seine Modelle nicht aufgelistet.' },
  { cause: 'network', en: 'The provider could not be reached from this page.', de: 'Der Anbieter konnte von dieser Seite aus nicht erreicht werden.' },
  { cause: 'timeout', en: 'The provider did not answer in time.', de: 'Der Anbieter hat nicht rechtzeitig geantwortet.' },
  { cause: 'unreadable', en: 'The browser did not let this page read the model list. Chat may still work.', de: 'Der Browser hat dieser Seite das Lesen der Modellliste nicht erlaubt. Chat kann trotzdem funktionieren.' },
  { cause: 'rate-limit', en: 'The provider is limiting requests. Wait a moment and save it again.', de: 'Der Anbieter begrenzt die Anfragen. Warten Sie einen Moment und speichern Sie erneut.' },
  { cause: 'provider', en: 'The provider could not answer the model-list request.', de: 'Der Anbieter konnte die Anfrage nach der Modellliste nicht beantworten.' },
  { cause: 'unknown', en: 'The model list could not be checked.', de: 'Die Modellliste konnte nicht geprüft werden.' },
];

for (const locale of ['en', 'de'] as const) {
  describe(`${locale} profile probe feedback`, () => {
    it('keeps the local server’s actionable setup guidance without calling it a provider reply', async () => {
      if (locale === 'de') await activateCatalogue('de');
      else activateEnglish();
      const guidance = 'Ollama: set OLLAMA_ORIGINS and restart the server.';
      const failure = probeFailureOf(new ProviderError('network', guidance, { permanent: true }));
      expect(failure).toEqual({ cause: 'network', guidance });
      expect(probeFailureMessage('Schreibmodell', failure).detail).toEqual({ label: locale === 'de' ? 'Verbindungshinweise:' : 'Connection guidance:', text: guidance });
    });
    it.each(causes)('names $cause once and keeps the provider reply separate', async ({ cause, en, de }) => {
      if (locale === 'de') await activateCatalogue('de');
      else activateEnglish();
      const providerReply = 'Provider text remains unchanged: <invalid key>.';
      const message = probeFailureMessage('Schreibmodell', { cause, providerReply });
      const prefix = locale === 'de' ? `„${isolate('Schreibmodell')}“ ist gespeichert, aber nicht verifiziert: ` : `“${isolate('Schreibmodell')}” is saved but not verified: `;
      expect(message.text).toBe(prefix + (locale === 'de' ? de : en));
      expect(message.detail).toEqual({ label: locale === 'de' ? 'Antwort des Anbieters:' : 'Provider reply:', text: providerReply });
      expect(message.text).not.toContain(providerReply);
      expect(probeFailureMessage('Schreibmodell', { cause }).detail).toBeUndefined();
    });
  });
}

it.each([
  { error: new ProviderError('auth', 'arbitrary wording'), cause: 'auth' },
  { error: new ProviderError('endpoint', 'arbitrary wording'), cause: 'models' },
  { error: new ProviderError('protocol', 'arbitrary wording'), cause: 'models' },
  { error: new ProviderError('network', 'arbitrary wording'), cause: 'network' },
  { error: new ProviderError('network', 'arbitrary wording', { reason: 'timeout' }), cause: 'timeout' },
  { error: new ProviderError('network', 'arbitrary wording', { reason: 'model-list-unreadable' }), cause: 'unreadable' },
  { error: new ProviderError('rate_limit', 'arbitrary wording'), cause: 'rate-limit' },
  { error: new ProviderError('provider', 'arbitrary wording'), cause: 'provider' },
  { error: new ProviderError('context_length', 'arbitrary wording'), cause: 'provider' },
  { error: new Error('timeout: Key rejected by a provider'), cause: 'unknown' },
])('classifies $cause from metadata, never from English text', ({ error, cause }) => {
  expect(probeFailureOf(error)).toEqual({ cause });
});

it('passes through only a separately identified provider reply', () => {
  const error = new ProviderError('provider', 'Generated gateway instruction', { detail: 'Internal diagnostic', providerReply: 'Original provider text' });
  expect(probeFailureOf(error)).toEqual({ cause: 'provider', providerReply: 'Original provider text' });
});
