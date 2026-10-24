/**
 * Settings › MCP & tools (extensibility §8, ui-modules §5.2): the master switch, the server cards, the review of each server's
 * tool list, the per-tool rows, the trust toggle, the add form, and the JSON import and export of the server list.
 *
 * The rules this section keeps are the client's, and it shows them as they are: a server is connected only by a click,
 * a tool list that changed waits for a review, a description is shown in full, and a trust grant is offered only after a
 * review. The section holds no state of its own beyond what the form is typing; everything it shows is read from the
 * client after each action.
 */

import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from 'react';
import { riskBadge, type ExternalToolDescriptor, type McpServerConfig, type McpServerHealth, type ReviewCard } from '@caotang/mcp-client';

import type { McpApp } from '../app/mcp.js';
import { mcpServerView, reviewHeading, reviewSummary, STATE_LABEL, toolStatusLabel } from '../app/mcp-model.js';
import { CatalogReview, CatalogRows } from './McpCatalog.js';
import { useComposingEnter } from './shared.js';

export function McpSection({ mcp }: { mcp: McpApp }): ReactNode {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const client = mcp.client;
  useEffect(() => {
    const stopHealth = client.onHealthChange(() => refresh());
    const stopTools = client.onToolListChanged(() => refresh());
    return () => {
      stopHealth();
      stopTools();
    };
  }, [client]);

  const settings = client.settings();
  const servers = settings.servers;

  return (
    <section className="settings-section mcp-section" aria-labelledby="settings-mcp">
      <h3 id="settings-mcp">MCP &amp; tools</h3>
      <p className="settings-note">
        External tool servers are connected by you, one at a time. Caotang does not reach a server until you connect it, and every
        call an agent makes to a server asks you first.
      </p>

      <div className="mcp-master">
        <label className="mcp-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={settings.enabled}
            checked={settings.enabled}
            data-testid="mcp-master"
            onChange={(event) => {
              void client.setMasterEnabled(event.target.checked).then(() => refresh());
            }}
          />
          <span>Use external tool servers</span>
        </label>
        <p className="field-note">
          {settings.enabled
            ? 'On. The servers below may be connected. Their tools are searchable only once their tool list has been reviewed.'
            : 'Off. No server is contacted, and no external tool is offered to the agent.'}
        </p>
      </div>

      <ol className="mcp-servers" aria-label="MCP servers">
        {servers.length === 0 ? <li className="field-note">No servers yet. Add one below, or import a list.</li> : null}
        {servers.map((server) => (
          <ServerCard key={server.key} mcp={mcp} server={server} onChanged={refresh} />
        ))}
      </ol>

      <AddServerForm mcp={mcp} onAdded={refresh} />
      <ImportExport mcp={mcp} onChanged={refresh} />
    </section>
  );
}

function ServerCard({ mcp, server, onChanged }: { mcp: McpApp; server: McpServerConfig; onChanged: () => void }): ReactNode {
  const client = mcp.client;
  const health: McpServerHealth = client.healthOf(server.key) ?? { key: server.key, state: 'configured' };
  const view = mcpServerView(server, health, client.review(server.key));
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown> | unknown, done?: string): Promise<void> => {
    setBusy(true);
    try {
      setMessage(outcomeMessage(await action(), done));
    } catch (error) {
      // A failure that is not a refusal is still a failure, and it is said: a vault that cannot
      // take a token back leaves a sealed token behind, and a rejection that vanishes would
      // leave the person with a card that says "Removed." and a token nobody can name.
      setMessage({ text: `The action did not finish: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' });
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <li className="mcp-server" data-server={server.name} data-state={health.state}>
      <header className="mcp-server-head">
        <div>
          <h4 className="mcp-server-name">{server.name}</h4>
          <p className="mcp-server-url">
            <code>{server.url}</code>
          </p>
        </div>
        <span className={`mcp-state is-${health.state}`} data-testid="mcp-state">
          <span className="mcp-dot" aria-hidden="true" />
          {STATE_LABEL[health.state]}
        </span>
      </header>
      <p className="mcp-detail" role="status" data-testid="mcp-detail">
        {view.detail}
      </p>
      <AuthLine mcp={mcp} server={server} />

      <div className="mcp-actions">
        {health.state === 'configured' ? (
          <>
            <button type="button" className="button is-primary" disabled={busy || !server.enabled} onClick={() => void run(() => mcp.connect(server.key), 'Connected.')}>
              Connect
            </button>
            <p className="field-note mcp-connect-note">Connecting contacts this address. Its tools stay confirm-only until you review them.</p>
          </>
        ) : (
          <button type="button" className="button" disabled={busy || !server.enabled} onClick={() => void run(() => mcp.refresh(server.key), 'Checked.')}>
            Check again
          </button>
        )}
        <button
          type="button"
          className="button is-quiet"
          disabled={busy}
          onClick={() => void run(() => client.updateServer(server.key, { enabled: !server.enabled }))}
        >
          {server.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          className="button is-quiet"
          disabled={busy}
          onClick={() => void run(() => client.disconnect(server.key), 'Disconnected.')}
        >
          Disconnect
        </button>
        <button type="button" className="button is-quiet" disabled={busy} onClick={() => void run(() => mcp.removeServer(server.key), 'Removed.')}>
          Remove
        </button>
      </div>

      <label className="mcp-trust">
        <input
          type="checkbox"
          aria-label={`Trusted for reads: ${server.name}`}
          checked={server.trustReads}
          disabled={!view.trustAvailable || busy}
          onChange={(event) => void run(() => client.setTrustReads(server.key, event.target.checked))}
        />
        <span>
          Trusted for reads. Lets read-only tools run without asking, and only tools the server marks read-only.
          {view.trustAvailable ? '' : ' Review the tool list first; the switch opens after the review.'}
        </span>
      </label>

      {view.review ? <ReviewPanel mcp={mcp} server={server} review={view.review} onChanged={onChanged} /> : null}

      <ToolRows mcp={mcp} server={server} onChanged={onChanged} />
      <CatalogRows
        status={client.catalogStatus(server.key)}
        prompts={client.listPrompts(server.key)}
        resources={client.listResources(server.key)}
        showLists={view.review === undefined}
      />

      <FormMessage message={message} />
    </li>
  );
}

function ReviewPanel({
  mcp,
  server,
  review,
  onChanged,
}: {
  mcp: McpApp;
  server: McpServerConfig;
  review: ReviewCard;
  onChanged: () => void;
}): ReactNode {
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const approve = (): void => {
    const outcome = mcp.client.approveReview(server.key, review.fingerprint);
    if (outcome.ok) setMessage({ text: reviewHeading(review).approved, tone: 'info' });
    else setMessage({ text: outcome.error, tone: 'error' });
    onChanged();
  };
  return (
    <section className="mcp-review" aria-label={`Review of ${server.name}`} data-testid="mcp-review">
      <h5>{reviewHeading(review).title}</h5>
      <p className="field-note">{reviewSummary(review)}</p>
      <ul className="mcp-review-tools">
        {review.tools.map((tool) => (
          <li key={tool.qualifiedName} data-tool-review={tool.toolName}>
            <p>
              <code>{tool.toolName}</code> <span className={`mcp-pin is-${tool.status}`}>{toolStatusLabel(tool.status)}</span>
            </p>
            <pre className="mcp-description" aria-label={`Full description of ${tool.toolName}`}>
              {tool.description === '' ? '(no description from the server)' : tool.description}
            </pre>
          </li>
        ))}
      </ul>
      {review.removed.length > 0 ? (
        <p className="field-note">
          Removed since the last review: {review.removed.map((removed) => removed.toolName).join(', ')}.
        </p>
      ) : null}
      <CatalogReview review={review} />
      <button type="button" className="button is-primary" onClick={approve}>
        {reviewHeading(review).approve}
      </button>
      <FormMessage message={message} />
    </section>
  );
}

function ToolRows({ mcp, server, onChanged }: { mcp: McpApp; server: McpServerConfig; onChanged: () => void }): ReactNode {
  const tools = mcp.client.listTools(server.key);
  if (tools.length === 0) return null;
  return (
    <table className="mcp-tools" aria-label={`Tools of ${server.name}`}>
      <thead>
        <tr>
          <th scope="col">Tool</th>
          <th scope="col">Risk</th>
          <th scope="col">Pin</th>
          <th scope="col">On</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => (
          <ToolRow key={tool.qualifiedName} mcp={mcp} server={server} tool={tool} onChanged={onChanged} />
        ))}
      </tbody>
    </table>
  );
}

function ToolRow({
  mcp,
  server,
  tool,
  onChanged,
}: {
  mcp: McpApp;
  server: McpServerConfig;
  tool: ExternalToolDescriptor;
  onChanged: () => void;
}): ReactNode {
  return (
    <tr data-tool={tool.toolName}>
      <td>
        <code>{tool.toolName}</code>
      </td>
      <td>
        <span className={`risk-badge is-${riskBadge(tool)}`}>{riskBadge(tool) === 'read' ? 'Read' : 'Asks first'}</span>
      </td>
      <td>
        <span className={`mcp-pin is-${tool.pinState}`}>{toolStatusLabel(tool.pinState)}</span>
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`Enable ${tool.toolName}`}
          checked={tool.enabled}
          onChange={(event) => {
            mcp.client.setToolEnabled(server.key, tool.toolName, event.target.checked);
            onChanged();
          }}
        />
      </td>
    </tr>
  );
}

/** The auth line of a card: none needed, or whether the token is in this browser's vault. */
function AuthLine({ mcp, server }: { mcp: McpApp; server: McpServerConfig }): ReactNode {
  const [present, setPresent] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  // The token form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving it.
  const ime = useComposingEnter();
  useEffect(() => {
    let alive = true;
    void mcp.tokenPresent(server.key).then((value) => {
      if (alive) setPresent(value);
    });
    return () => {
      alive = false;
    };
  }, [mcp, server.key, server.auth]);

  if (server.auth.kind === 'none') {
    return <p className="mcp-auth">Sign-in: none needed.</p>;
  }
  return (
    <div className="mcp-auth">
      <p>
        Sign-in: bearer token. <span data-testid="mcp-token-status">{present === null ? 'checking…' : present ? 'Token entered in this browser.' : 'Token missing. Enter it again.'}</span>
      </p>
      <form
        className="mcp-token"
        onKeyDown={ime.noteKey}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (ime.takesSubmit()) return;
          void mcp.setToken(server.key, token).then((outcome) => {
            if (outcome.ok) {
              setToken('');
              setPresent(true);
              setMessage({ text: 'Token saved. Check the connection again to confirm it.', tone: 'info' });
            } else {
              setMessage({ text: outcome.message, tone: 'error' });
            }
            refresh();
          });
        }}
      >
        <label>
          <span>Bearer token for {server.name}</span>
          <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <button type="submit" className="button">
          Save token
        </button>
      </form>
      <FormMessage message={message} />
    </div>
  );
}

function AddServerForm({ mcp, onAdded }: { mcp: McpApp; onAdded: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [sign, setSign] = useState<'none' | 'bearer'>('none');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  // The add form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from adding a server.
  const ime = useComposingEnter();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    void mcp
      .addServer({ name, url, ...(sign === 'bearer' ? { token } : {}) })
      .then((outcome) => {
        if (!outcome.ok) {
          setMessage({ text: outcome.message, tone: 'error' });
          return;
        }
        setMessage({ text: `Added “${outcome.server.name}”. It is not connected yet: connect it to review its tools.`, tone: 'info' });
        setName('');
        setUrl('');
        setToken('');
        onAdded();
      });
  };

  return (
    <form className="settings-form mcp-add" aria-label="Add a server" onKeyDown={ime.noteKey} onSubmit={submit} data-testid="mcp-add">
      <h4>Add a server</h4>
      <label>
        <span>Name</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>Server address (https://…, or http://localhost…)</span>
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label>
        <span>Sign-in</span>
        <select value={sign} onChange={(event) => setSign(event.target.value === 'bearer' ? 'bearer' : 'none')}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
        </select>
      </label>
      {sign === 'bearer' ? (
        <label>
          <span>Bearer token</span>
          <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
      ) : null}
      <button type="submit" className="button is-primary">
        Add server
      </button>
      <FormMessage message={message} />
    </form>
  );
}

function ImportExport({ mcp, onChanged }: { mcp: McpApp; onChanged: () => void }): ReactNode {
  const [text, setText] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: readonly string[]; refused: readonly { entry: string; reason: string }[] } | null>(null);
  return (
    <section className="mcp-io" aria-label="Server list as JSON">
      <h4>Server list as JSON</h4>
      <p className="field-note">The list holds names, addresses and enabled tools. It never holds a token, a review or a trust grant.</p>
      <label className="settings-form">
        <span>Import a list</span>
        <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} aria-label="Server list to import" />
      </label>
      <div className="mcp-actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            setResult(mcp.importServers(text, new Date().toISOString()));
            setText('');
            onChanged();
          }}
        >
          Import
        </button>
        <button type="button" className="button is-quiet" onClick={() => setShown(mcp.exportText())}>
          Show the list
        </button>
      </div>
      {result !== null ? (
        <div className="mcp-import-result" role="status" data-testid="mcp-import-result">
          <p>{result.added.length === 0 ? 'No server was added.' : `Added ${result.added.length}: ${result.added.join(', ')}.`}</p>
          {result.refused.length > 0 ? (
            <ul aria-label="Refused entries">
              {result.refused.map((refusal) => (
                <li key={`${refusal.entry}:${refusal.reason}`}>
                  {refusal.entry}: {refusal.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {shown !== null ? <textarea className="mcp-export" readOnly rows={8} aria-label="Server list" value={shown} /> : null}
    </section>
  );
}

function FormMessage({ message }: { message: { readonly text: string; readonly tone: 'info' | 'error' } | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={`form-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      {message.text}
    </p>
  );
}

/** A client action's outcome when it is a `Result`, so a refused one can be shown in words. */
function isFailure(outcome: unknown): outcome is { ok: false; error: string } {
  return typeof outcome === 'object' && outcome !== null && (outcome as { ok?: unknown }).ok === false;
}

/** A server's health, as connect and refresh return it. */
function isHealth(outcome: unknown): outcome is McpServerHealth {
  return typeof outcome === 'object' && outcome !== null && 'state' in outcome && 'key' in outcome;
}

/**
 * What a card says after an action. A refused action says why. A connection that did not come up is a failure as well: its
 * health is `configured` with the reason, and the card shows that reason, never "Connected." (extensibility §3.2).
 */
function outcomeMessage(outcome: unknown, done: string | undefined): { text: string; tone: 'info' | 'error' } | null {
  if (isFailure(outcome)) return { text: outcome.error, tone: 'error' };
  if (isHealth(outcome) && outcome.state === 'configured') return { text: outcome.detail ?? 'The server is not connected.', tone: 'error' };
  return done === undefined ? null : { text: done, tone: 'info' };
}
