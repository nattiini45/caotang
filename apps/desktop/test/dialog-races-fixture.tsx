import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { MemoryArtifactFs, MemoryIndexedDb, addDocument, createEmptyManifest, createProjectState, openRuntimeStore } from '@caotang/store';
import { ExportDialog } from '../src/components/ExportDialog.js';
import { EncodingDialog } from '../src/components/EncodingDialog.js';
import { ProjectSession } from '../src/app/session.js';
import type { PendingEncoding } from '../src/app/lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function host() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  return { root, render: (child: ReturnType<typeof createElement>) => root.render(createElement(I18nProvider, { i18n }, child)) };
}

export async function mountExportRace(failReadiness: boolean) {
  const state = createProjectState(createEmptyManifest('B2 export race', new Date(), { locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The harbour', body: 'The boat came in.', id: 'n_B2RACE0001', now: new Date() });
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const actualReady = session.exportsReady.bind(session);
  const actualIdle = session.exportsIdle.bind(session);
  let ready = deferred<void>();
  const idle = deferred<void>();
  let calls = 0;
  session.exportsReady = () => ++calls === 1 && failReadiness ? Promise.reject(new Error('B2 readiness failed')) : ready.promise.then(actualReady);
  session.exportsIdle = () => idle.promise.then(actualIdle);
  const mounted = host();
  let closes = 0;
  mounted.render(createElement(ExportDialog, { session, selection: null, onClose: () => { closes++; mounted.root.unmount(); } }));
  return {
    ready: () => ready.resolve(),
    failReady: () => { ready.reject(new Error('B2 compile readiness failed')); ready = deferred<void>(); },
    stop: () => idle.resolve(), closes: () => closes, unmount: () => mounted.root.unmount(),
  };
}

export function mountEncodingRace() {
  const bytes = Uint8Array.from([72, 101, 32, 0x93, 72, 105, 0x94, 32, 0xe9]);
  const answers: ReturnType<typeof deferred<'windows-1252' | 'utf-16le' | undefined>>[] = [];
  const fs = new MemoryArtifactFs();
  fs.readBytes = async () => bytes;
  const pending: PendingEncoding = {
    name: 'B2 encoding race',
    issues: [{ path: 'docs/old.md', kind: 'document', encoding: 'windows-1252', size: bytes.length }],
    fs,
    resume: { kind: 'bundle', sessions: [], assets: {}, coherence: undefined, tasks: undefined },
    cancelNote: '',
  };
  const mounted = host();
  mounted.render(createElement(EncodingDialog, {
    pending, busy: false,
    asker: { profileName: 'B2 scripted provider', ask: () => {
      const answer = deferred<'windows-1252' | 'utf-16le' | undefined>();
      answers.push(answer);
      return answer.promise;
    } },
    onDone: () => mounted.root.unmount(), onCancel: () => mounted.root.unmount(),
  }));
  return {
    answer: (index = 0) => answers[index]?.resolve('utf-16le'),
    fail: (index = 0) => answers[index]?.reject(new Error('B2 advice failed')),
    unmount: () => mounted.root.unmount(),
  };
}
