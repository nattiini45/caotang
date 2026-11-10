import './csp.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initInterface } from './app/interface.js';
import { initTheme } from './app/theme.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { publishDocumentLanguage } from './i18n/language.js';
import { activateEnglish } from './i18n/runtime.js';
import './tokens/classic.css';
import './styles.css';
import './features.css';

initTheme();

// The compiled English catalogue is in the entry, and this activates it before the first render, so no
// label flashes an id and every message has its per-message English fallback (i18n.md §3.3). The root
// attributes agree with it until the stored preference has loaded. A switch updates them in place.
activateEnglish();
publishDocumentLanguage('en');

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
const root = el;
const scrollRoot = document.body;
const scrollSurfaces = new MutationObserver(() => {
  if (scrollRoot.querySelector('dialog[open], .rail-panel, .modern-binder, .modern-drawer-panel') === null) return;
  scrollSurfaces.disconnect();
  void import('./app/scroll-edges.js').then(({ installScrollEdges }) => installScrollEdges(scrollRoot)).catch(() => undefined);
});
scrollSurfaces.observe(scrollRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });

// The interface (Classic or Modern) is on the page before the first render, and a Modern page waits for its stylesheet, so it never paints as Classic
// first. A stylesheet that failed to load leaves Modern's tokens out and the page renders anyway. The interface language is the
// I18nProvider's: English is active before this line, and a stored language activates inside it.
const render = (): void => {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
};
initInterface().then(render, render);
