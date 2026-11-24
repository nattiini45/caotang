/**
 * Settings › MCP & tools › This project's server (desktop.md #the-projects-own-mcp-server-406): the server this app runs over the open
 * folder, the address and token a host is pointed at, and the one setting that lets a host change the project.
 *
 * The block exists only where the app can run a server: the browser build has no bridge, so `McpSection` renders nothing there. The
 * server's state belongs to the main process, so this component keeps no copy of it — it reads it once, follows what the main process
 * publishes, and every button acts there and shows what came back.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useState, type ReactNode } from 'react';

import {
  projectServerConfig,
  projectServerStatus,
  startProjectServer,
  stopProjectServer,
  subscribeProjectServer,
  type McpHostRefusal,
  type McpHostState,
  type McpHostStatus,
} from '../app/native-mcp.js';

/** The sentence a refusal the page cannot fix itself is shown as. The server's own words win when it gave any. */
export function refusalSentence(refusal: McpHostRefusal, detail?: string): string {
  switch (refusal) {
    case 'bundle-missing':
      return t`The server’s program is missing from this copy of the app. Install Caotang for desktop again.`;
    case 'no-folder':
      return t`This project is not in a folder yet. Save it to a folder to serve it.`;
    case 'busy':
      return t`Another program is already using this folder, such as an MCP server you started yourself. Stop it, then start this one.`;
    default:
      return detail === undefined || detail.trim() === '' ? t`The server stopped before it was ready. Start it again.` : detail.trim();
  }
}

function stateLabel(state: McpHostState): string {
  switch (state) {
    case 'stopped':
      return t`Stopped`;
    case 'starting':
      return t`Starting…`;
    case 'running':
      return t`Running`;
    case 'failed':
      return t`Not running`;
  }
}

/** The state pill's colour class, as the server cards use it. */
function stateClass(state: McpHostState): string {
  switch (state) {
    case 'running':
      return 'is-connected';
    case 'starting':
      return 'is-connecting';
    case 'failed':
      return 'is-failed';
    case 'stopped':
      return '';
  }
}

export function ProjectServerSection({ folderId }: { readonly folderId: string | undefined }): ReactNode {
  useLingui();
  const [status, setStatus] = useState<McpHostStatus | null>(null);
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);

  useEffect(() => {
    let live = true;
    // An event that arrives while the first read is in flight is fresher than the read's answer, so the answer is dropped: the
    // difference is a start or a stop the writer just asked for, and showing the state before it would undo it on screen.
    let heard = false;
    const stop = subscribeProjectServer((next) => {
      if (!live) return;
      heard = true;
      setStatus(next);
    });
    void projectServerStatus()
      .then((next) => {
        if (live && !heard && next !== undefined) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, []);

  const state: McpHostState = status?.state ?? 'stopped';
  const running = state === 'running';
  // While the server runs or starts, the setting it was started with is the truth; stopped, the switch is what the next start uses.
  const writes = state === 'running' || state === 'starting' ? status?.allowWrites === true : allowWrites;
  const config = running && status !== null ? projectServerConfig(status) : null;

  const act = async (action: () => Promise<McpHostStatus | undefined>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await action();
      // A start that failed shows its own sentence from the status below, so nothing is said twice.
      if (next !== undefined) setStatus(next);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const start = async (withWrites: boolean): Promise<void> => {
    if (folderId === undefined) return;
    await act(() => startProjectServer(folderId, withWrites));
  };

  const copy = async (text: string): Promise<void> => {
    setMessage(null);
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ text: t`Copied. Paste it into the program that should read this project.`, tone: 'info' });
    } catch {
      // A page that cannot reach the clipboard still shows every value, so the writer selects it and copies it by hand.
      setMessage({ text: t`The copy was refused here. Select the text and copy it by hand.`, tone: 'error' });
    }
  };

  return (
    <section className="mcp-project" aria-labelledby="settings-mcp-project">
      <div className="mcp-server-head">
        <h4 id="settings-mcp-project"><Trans>This project’s server</Trans></h4>
        <p className={`mcp-state ${stateClass(state)}`} data-testid="mcp-project-state">
          <span className="mcp-dot" aria-hidden="true" />
          {stateLabel(state)}
        </p>
      </div>
      <p className="field-note">
        <Trans>A program on this computer — Claude Desktop, a script, any MCP host — can read this project while the server runs, and
        nothing leaves the computer.</Trans>
      </p>

      {running ? (
        <div className="mcp-connection">
          <div className="mcp-connection-row">
            <span className="mcp-connection-label"><Trans>Address</Trans></span>
            <input
              type="text"
              readOnly
              value={status?.url ?? ''}
              aria-label={t`The address an MCP host connects to`}
              data-testid="mcp-project-url"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="button is-quiet" disabled={busy} onClick={() => void copy(status?.url ?? '')}>
              <Trans>Copy the address</Trans>
            </button>
          </div>
          <div className="mcp-connection-row">
            <span className="mcp-connection-label"><Trans>Token</Trans></span>
            <input
              type="text"
              readOnly
              value={status?.token ?? ''}
              aria-label={t`The token the address takes`}
              data-testid="mcp-project-token"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="button is-quiet" disabled={busy} onClick={() => void copy(status?.token ?? '')}>
              <Trans>Copy the token</Trans>
            </button>
          </div>
        </div>
      ) : null}

      {state === 'failed' ? (
        <p className="field-note is-complaint" role="alert" data-testid="mcp-project-refusal">
          {refusalSentence(status?.refusal ?? 'failed', status?.detail)}
        </p>
      ) : null}

      <div className="mcp-actions">
        {running || state === 'starting' ? (
          <button type="button" className="button" disabled={busy} data-testid="mcp-project-stop" onClick={() => void act(() => stopProjectServer())}>
            <Trans>Stop</Trans>
          </button>
        ) : (
          <button
            type="button"
            className="button is-primary"
            disabled={busy || folderId === undefined}
            data-testid="mcp-project-start"
            onClick={() => void start(writes)}
          >
            <Trans>Start</Trans>
          </button>
        )}
        {config !== null ? (
          <button type="button" className="button is-quiet" disabled={busy} data-testid="mcp-project-config" onClick={() => void copy(config)}>
            <Trans>Copy the configuration</Trans>
          </button>
        ) : null}
      </div>

      <div className="mcp-project-writes">
        <label className="mcp-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={writes}
            checked={writes}
            disabled={busy}
            data-testid="mcp-project-writes"
            onChange={(event) => {
              const on = event.target.checked;
              setAllowWrites(on);
              // The tools a server lists are fixed when it opens the project, so changing this setting restarts it.
              if (running || state === 'starting') void start(on);
            }}
          />
          <span><Trans>Allow changes</Trans></span>
        </label>
        <p className="field-note">
          {writes
            ? t`On. A host may change this project: it writes the same files you do, and a write that would replace text you have not saved is refused instead.`
            : t`Off. A host can read this project and change nothing.`}
        </p>
      </div>

      <p className="field-note">
        <Trans>While Caotang saves, the server is paused and refuses writes, so a save and a host’s change never replace each other.</Trans>
      </p>

      {folderId === undefined ? (
        <p className="field-note"><Trans>This project is not in a folder yet. Save it to a folder to serve it.</Trans></p>
      ) : null}

      {message !== null ? (
        <p className={message.tone === 'error' ? 'field-note is-complaint' : 'field-note'} role="status" data-testid="mcp-project-message">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
