import './csp.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initTheme } from './app/theme.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { activateEnglish } from './i18n/runtime.js';
import './styles.css';
import './features.css';

initTheme();

// The compiled English catalogue is in the entry, and this activates it before the first render, so no
// label flashes an id and every message has its per-message English fallback (i18n.md §3.3).
activateEnglish();

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
