// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { WireError, WireLoadError, type HealthFailureReason, type McpServerConfig } from '@caotang/mcp-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { McpApp } from '../src/app/mcp.js';
import { McpSection } from '../src/components/McpSection.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

const GERMAN: Record<HealthFailureReason, string> = {
  network: 'Der Server hat nicht geantwortet. Prüfen Sie die Adresse oben und wählen Sie dann Verbinden, um es erneut zu versuchen.',
  cors: 'Dieser Server lässt keine Verbindungen aus einem Browser zu. Bitten Sie den Betreiber, Verbindungen von dieser App zu erlauben, und wählen Sie dann erneut Verbinden.',
  timeout: 'Der Server hat zu lange für eine Antwort gebraucht. Wählen Sie Verbinden, um es erneut zu versuchen.',
  abort: 'Die Verbindung wurde abgebrochen. Wählen Sie Verbinden, um es erneut zu versuchen.',
  auth: 'Der Server hat die Anmeldung abgelehnt. Prüfen Sie das Token für diesen Server und wählen Sie dann erneut Verbinden.',
  http: 'Der Server hat einen HTTP-Fehler gemeldet. Prüfen Sie die Adresse oben und wählen Sie dann erneut Verbinden.',
  protocol: 'Der Server hat einen Fehler gemeldet, den Caotang nicht einordnen konnte. Prüfen Sie die Serverdetails und wählen Sie dann erneut Verbinden.',
  result: 'Der Server hat eine Werkzeugliste gesendet, die Caotang nicht lesen konnte. Bitten Sie den Betreiber, die Werkzeugliste zu prüfen, und wählen Sie dann erneut Verbinden.',
  revision: 'Dieser Server verwendet eine MCP-Version, die Caotang nicht unterstützt. Bitten Sie den Hersteller um eine Aktualisierung und wählen Sie dann erneut Verbinden.',
  'not-found': 'Unter dieser Adresse bietet der Server keine Werkzeugliste an. Prüfen Sie die Adresse oben und wählen Sie dann erneut Verbinden.',
  'input-required': 'Der Server verlangt weitere Angaben für die Verbindung. Caotang kann sie hier nicht übermitteln. Prüfen Sie die Anmeldeanforderungen des Servers und wählen Sie dann erneut Verbinden.',
  'connector-load': 'Die MCP-Verbindungskomponente konnte nicht geladen werden. Prüfen Sie Ihre Internetverbindung und wählen Sie dann erneut Verbinden.',
  'token-missing': 'Das Bearer-Token fehlt. Geben Sie es auf dieser Karte ein, speichern Sie es und wählen Sie dann erneut Verbinden.',
};

const RAW_SERVER_TEXT = 'Unclassified <script>window.bad = true</script> response.';
const SERVER: McpServerConfig = {
  key: 's_AAAAAAAAAA', name: 'Story Bible', url: 'https://tools.example.test/mcp', transport: 'http',
  enabled: true, trustReads: false, auth: { kind: 'none' }, pinnedTools: {}, addedAt: '2026-11-10T00:00:00Z',
};

function renderCard(mcp: McpApp): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<I18nProvider i18n={i18n}><McpSection mcp={mcp} /></I18nProvider>);
  const card = host.querySelector<HTMLElement>('[data-server="Story Bible"]');
  if (card === null) throw new Error('The server card was not rendered.');
  return card;
}

afterEach(() => activateEnglish());

describe('catalog-backed MCP failure cards', () => {
  it.each(Object.entries(GERMAN) as [HealthFailureReason, string][])('shows one German alert, not an English reason, for %s', async (reason, expected) => {
    const server: McpServerConfig = { ...SERVER, auth: reason === 'token-missing' ? { kind: 'bearer', tokenRef: 'mcp:test' } : { kind: 'none' } };
    const mcp = new McpApp({
      settings: { current: () => ({ enabled: true, servers: [server] }), update: async () => null },
      keys: { put: async () => undefined, reveal: async () => undefined, has: async () => false, remove: async () => undefined },
      wire: () => {
        if (reason === 'connector-load') throw new WireLoadError(RAW_SERVER_TEXT);
        if (reason === 'token-missing') throw new Error('A missing token must not reach the wire.');
        throw new WireError(reason, RAW_SERVER_TEXT);
      },
    });
    expect(await mcp.connect(server.key)).toMatchObject({ state: 'failed', reason });
    const english = renderCard(mcp).querySelector('[role="alert"]')?.textContent;
    await activateCatalogue('de');
    const card = renderCard(mcp);
    const alerts = card.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe(expected);
    expect(alerts[0]?.textContent).not.toBe(english);
    expect(alerts[0]?.textContent).not.toContain(RAW_SERVER_TEXT);
    expect(alerts[0]?.textContent).toMatch(/^[A-ZÄÖÜ].*\.$/);
    expect(card.querySelector('[data-testid="mcp-detail"]')).toBeNull();
    expect(card.textContent).not.toContain('Settings › MCP & tools');
    expect(card.querySelector('script')).toBeNull();
    if (reason === 'protocol') {
      const details = card.querySelector('details');
      expect(details?.querySelector('summary')?.textContent).toBe('Serverdetails');
      expect(details?.hasAttribute('open')).toBe(false);
      expect(details?.textContent).toContain(RAW_SERVER_TEXT);
    } else {
      expect(card.textContent).not.toContain(RAW_SERVER_TEXT);
    }
    await mcp.client.close();
  });
});
