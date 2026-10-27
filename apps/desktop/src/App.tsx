/**
 * The root. It opens the browser's runtime store and the app's services (settings, providers) once, then shows either the
 * projects screen or the writing shell for the one project that is open.
 *
 * Switching projects settles the one being left before it closes, so no keystroke is lost on the way out. Leaving the shell
 * is gated on the same check (see `Workspace`). Opening a project asks the browser to keep its storage (ui-modules §5.3).
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RuntimeStoreNewerError, type RuntimeStore } from '@caotang/store';

/* lingui-set comment="Interpolated values: error" */

import { runtimeStore } from './app/runtime.js';
import { activeCoherenceModel } from './app/coherence-review.js';
import { droppedFieldsSentence } from './app/integrity-model.js';
import { fixtureWireFactory } from './app/mcp.js';
import { openAppServices, type AppServices } from './app/services.js';
import type { DirectoryHandleLike } from './app/fs-access.js';
import { initializeInterfaceLanguage, languageRevision, subscribeLanguage } from './i18n/language.js';
import { openDemoSample, setSessionDefaults, type Opened } from './app/lifecycle.js';
import { browserStorageHost, requestDurability } from './app/storage.js';
import type { ProjectSession } from './app/session.js';
import { installTestHook } from './app/test-hook.js';
import { Home } from './components/Home.js';
import { Workspace } from './components/Workspace.js';

/** A demo run waiting for the shell it starts in: the intent to submit once the agent panel is there. */
export interface StartIntent {
  readonly intent: string;
  /** Distinguishes two runs of one intent, so the shell submits each run once. */
  readonly serial: number;
}

export function App(): ReactNode {
  const [store, setStore] = useState<RuntimeStore | null>(null);
  const [services, setServices] = useState<AppServices | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Set when the failure is a store another tab upgraded past this build: its message says what to do, so the storage paragraph is left out.
  const [failureNewer, setFailureNewer] = useState(false);
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startIntent, setStartIntent] = useState<StartIntent | null>(null);
  // The folder the writer chose to save this browser's version into, as the project opens (lifecycle `answerFolderDiffers`).
  const [saveToFolder, setSaveToFolder] = useState<DirectoryHandleLike | null>(null);
  // The session in view, mirrored in a ref so the test hook and the switch logic read the current one without re-rendering for it.
  const current = useRef<ProjectSession | null>(null);
  const serial = useRef(0);
  // A switch activates in place; re-rendering the tree keeps the editor, its journal and every open
  // card exactly where they are (i18n.md §3.3: no reload).
  useSyncExternalStore(subscribeLanguage, languageRevision);

  useEffect(() => {
    let alive = true;
    runtimeStore().then(
      (opened) => {
        if (alive) setStore(opened);
      },
      (error: unknown) => {
        if (!alive) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setFailureNewer(error instanceof RuntimeStoreNewerError);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
    // The MCP transport is the development fixture's only in a development build; a shipped build uses the SDK's wire.
    const mcpWire = import.meta.env.DEV ? fixtureWireFactory() : undefined;
    openAppServices(factory, { mcpWire }).then(async (opened) => {
      // The stored interface language is loaded before the first real screen, so the writer does not
      // see English and then watch it change. A failed catalogue falls back to English with a notice.
      const languageFailure = await initializeInterfaceLanguage(opened.settings.current().interfaceLanguage);
      if (!alive) return;
      if (languageFailure !== null) setNotice(languageFailure);
      setServices(opened);
      // The session defaults follow the settings: the debounce and the checkpoint limits a new session starts with.
      const apply = (): void => {
        const { editor, retention } = opened.settings.current();
        // The agent's coherence scans follow the Coherence settings, and its review runs through the active provider (coherence.md §7).
        const coherence = { checks: () => opened.settings.current().coherence.enabledChecks, model: () => activeCoherenceModel(opened.providers) };
        setSessionDefaults({ debounceMs: editor.autosaveDebounceMs, retention, mcp: { client: opened.mcp.client }, coherence });
      };
      apply();
      opened.settings.subscribe(apply);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    installTestHook(() => current.current);
  }, []);

  const show = (opened: Opened): void => {
    const previous = current.current;
    current.current = opened.session;
    setNotice(noticeFor(opened));
    setSaveToFolder(opened.saveToFolder ?? null);
    setSession(opened.session);
    if (previous !== null && previous !== opened.session) {
      void previous.settle().then(() => closeSession(previous));
    }
    // The browser is asked once per open, and not again once it has said yes (ui-modules §5.3). The answer lands on the session.
    const host = browserStorageHost();
    void requestDurability(host).then((durability) => {
      if (current.current === opened.session) opened.session.setDurability(durability);
    });
  };

  const goHome = (): void => {
    const previous = current.current;
    current.current = null;
    setNotice(null);
    setSaveToFolder(null);
    setSession(null);
    setStartIntent(null);
    // The workspace goes at once, so nothing is typed into a session that is closing. The projects list does not take the lease this
    // close still holds for another tab's (lifecycle `openElsewhere`).
    if (previous !== null) closeSession(previous);
  };

  /** Ends a session. A writing session that could not be recorded is said, not dropped in silence. */
  const closeSession = (leaving: ProjectSession): void => {
    void leaving.close().catch((error: unknown) => {
      const errorText = error instanceof Error ? error.message : String(error);
      setNotice(t`The writing session could not be recorded: ${{ error: errorText }}`);
    });
  };

  /**
   * Runs a demo intent: the writer's sample project (made the first time, then reused), then the shell with the intent submitted
   * in its agent panel. A sample made here is recorded in the settings, so the agent panel offers the demo intents for it.
   */
  const runDemo = (intent: string): void => {
    if (store === null || services === null) return;
    // A failure anywhere in opening the sample, including recording it in the settings, arrives here: `openDemoSample` closes a
    // session it made and could not record, so no lease is left held by a session the shell never shows.
    void openDemoSample(store, services.settings).then(
      (session) => {
        serial.current += 1;
        show({ session, notices: [], droppedFields: [], copiedFrom: null });
        setStartIntent({ intent, serial: serial.current });
      },
      (error: unknown) => {
        const errorText = error instanceof Error ? error.message : String(error);
        setNotice(t`The sample could not be opened: ${{ error: errorText }}`);
      },
    );
  };

  if (failure !== null) {
    return (
      <main className="fatal" role="alert">
        <h1>
          <Trans>Caotang could not open its storage</Trans>
        </h1>
        <p>{failure}</p>
        {failureNewer ? null : (
          <p>
            <Trans>Projects are kept in this browser’s storage. Check that it is enabled for this site, then reload.</Trans>
          </p>
        )}
      </main>
    );
  }
  if (store === null || services === null) {
    return (
      <main className="loading" role="status">
        <Trans>Opening your projects…</Trans>
      </main>
    );
  }
  if (session !== null) {
    return (
      <Workspace
        session={session}
        store={store}
        services={services}
        onHome={goHome}
        notice={notice}
        startIntent={startIntent}
        saveToFolder={saveToFolder}
      />
    );
  }
  const notices = [...services.notices, ...(notice === null ? [] : [notice])];
  return <Home store={store} services={services} onOpened={show} onRunDemo={runDemo} notices={notices} />;
}

/**
 * What an opening should say to the person who asked for it: a copy made, each notice the load raised (its own sentence, so the identity
 * made at open is not lost behind a count), and the fields a save will drop. Only the fields are counted as dropped.
 */
function noticeFor(opened: Opened): string | null {
  const lines: string[] = [];
  if (opened.copiedFrom !== null) {
    // A copy of a folder's project may differ from the folder, and cannot be saved back into it (lifecycle `saveFolder`).
    lines.push(
      opened.session.folderBaseline() !== null
        ? t`That project is already in this browser, so the folder opened as a separate copy. This copy may differ from the folder, and saving it into that folder is refused. The original is in the projects list.`
        : t`That project is already in this browser, so the file opened as a separate copy.`,
    );
  }
  // Each line is a whole sentence (lifecycle `noticesOf`, `openNoticeLines`), so joining them with a space reads as prose.
  lines.push(...opened.notices);
  const recovered = opened.session.reloadNotice();
  if (recovered !== null) lines.push(recovered);
  const dropped = droppedFieldsSentence(opened.droppedFields);
  if (dropped !== null) lines.push(dropped);
  return lines.length === 0 ? null : lines.join(' ');
}
