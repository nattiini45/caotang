import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { MemoryIndexedDb, addDocument, createEmptyManifest, createProjectState, openRuntimeStore } from '@caotang/store';
import { COMPILE_LOG_PATH } from '@caotang/exporter';
import { ExportDialog } from '../src/components/ExportDialog.js';
import { ProjectSession } from '../src/app/session.js';

export async function mountExportJobFailure(logFailure: boolean) {
  const state = createProjectState(createEmptyManifest('B8 export job', new Date(), { locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The harbour', body: 'The boat came in.', id: 'n_B8EXPORT01', now: new Date() });
  const session = new ProjectSession({ store: await openRuntimeStore(new MemoryIndexedDb()), projectId: state.manifest.project.id, state, shadow: null });
  const write = session.exports.artifacts.writeAtomic;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let failed = false;
  session.exports.artifacts.writeAtomic = async (path, contents) => {
    if (!failed && (logFailure ? path === COMPILE_LOG_PATH : path.endsWith('.md'))) {
      await gate;
      failed = true;
      throw new Error(logFailure ? 'The compile log could not be saved.' : 'The export folder is full.');
    }
    await write(path, contents);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(I18nProvider, { i18n }, createElement(ExportDialog, { session, selection: null, onClose: () => root.unmount() })));
  return { fail: release };
}
