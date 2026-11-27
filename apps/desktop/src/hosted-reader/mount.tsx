import '../csp.js';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../app/theme.js';
import { publishDocumentLanguage } from '../i18n/language.js';
import { loadMessages } from '../i18n/runtime.js';
import { HostedReader } from './reader.js';
import type { ReaderSource } from './read.js';
import '../tokens/classic.css';
import './reader.css';

export function mountHostedReader(element: HTMLElement, source: ReaderSource): () => void {
  initTheme();
  const root = createRoot(element);
  const wanted = source.language ?? 'en';
  void loadMessages(wanted).then(
    (messages) => ({ tag: wanted, messages }),
    async () => ({ tag: 'en', messages: await loadMessages('en') }),
  ).then(({ tag, messages }) => {
    if (source.signal.aborted) return;
    publishDocumentLanguage(tag);
    const i18n = setupI18n({ locale: tag, messages: { [tag]: messages } });
    root.render(<I18nProvider i18n={i18n}><HostedReader source={source} /></I18nProvider>);
  });
  return () => root.unmount();
}
