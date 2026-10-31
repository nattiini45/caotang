import './csp.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initInterface } from './app/interface.js';
import { initTheme } from './app/theme.js';
import './styles.css';
import './features.css';

initTheme();

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
const root = el;

// The interface (Classic or Modern) is on the page before the first render, and a Modern page waits for its stylesheet, so it never paints as Classic
// first. A stylesheet that failed to load leaves Modern's tokens out and the page renders anyway.
const render = (): void => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
};
initInterface().then(render, render);
