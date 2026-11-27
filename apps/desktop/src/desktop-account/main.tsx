import '../csp.js';
import '../tokens/classic.css';
import '../styles.css';
import './style.css';
import { Button } from '@ui-sdk/react/button';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { importProjectKey, openProjectRecord, rotationPending, unlockAccountKeys, unwrapProjectKey, type AccountKeyRecord, type SecretKey } from '@caotang/crypto';
import { RemoteSessionError, createHttpLease, createHttpProjectRegistry, type RemoteProjectRecord } from '@caotang/remote-store';
import en from './copy.en.json';
import de from './copy.de.json';
import { createShellLease, LEASE_HEARTBEAT_MS, type ShellLease } from './lease.js';
import type { AccountHostWindow, AccountStudioHandoff, AccountStudioWindow } from './studio.js';
import { ACCOUNT_ORIGIN, bridge, createAccountFetch, type AccountBridge, type AccountState } from './transport.js';
import { workerKdf } from './worker-kdf.js';

const language = navigator.language.startsWith('de') ? 'de' : 'en';
const words: typeof en = language === 'de' ? de : en;
const ADDRESS = 'caotang-desktop-account.address';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
type Problem = keyof typeof words;
type Session = { readonly origin: string; readonly account: string; readonly login: string; readonly scope: string; readonly record: AccountKeyRecord };
type Project = { readonly row: RemoteProjectRecord; readonly name: string };
type Unlocked = { readonly master: SecretKey; readonly projects: readonly Project[]; readonly unreadable: boolean };

async function accountScope(origin: string, account: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([origin, account]))));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function AccountWindow({ native }: { readonly native: AccountBridge }) {
  const [fetchAccount] = useState(() => createAccountFetch(native));
  const [kdf] = useState(workerKdf);
  const [connection, setConnection] = useState<AccountState>({ kind: 'signed-out' });
  const [savedAddress, setSavedAddress] = useState(() => localStorage.getItem(ADDRESS) ?? '');
  const [address, setAddress] = useState(savedAddress);
  const [session, setSession] = useState<Session | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [active, setActive] = useState<AccountStudioHandoff | null>(null);
  const [blocked, setBlocked] = useState<Project | null>(null);
  const [notice, setNotice] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [device] = useState(() => crypto.randomUUID());
  const frame = useRef<HTMLIFrameElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lease = useRef<ShellLease | null>(null);
  const leaving = useRef<Promise<boolean> | null>(null);
  const renewing = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (localStorage.getItem(ADDRESS) === null) void native.configuredOrigin().then((configured) => { if (configured) setAddress(configured); });
  }, [native]);

  useEffect(() => {
    heading.current?.focus();
  }, [active, connection.kind, session, unlocked]);

  useEffect(() => () => kdf.close(), [kdf]);

  useEffect(() => {
    const host = window as AccountHostWindow;
    host.renewAccountLease = async () => {
      if (renewing.current) return renewing.current;
      const candidate = lease.current;
      if (!candidate || leaving.current) return false;
      const current = candidate.state();
      if (current.leased && current.until > Date.now()) return true;
      const attempt = candidate.take().then((next) => {
        if (lease.current !== candidate || leaving.current) return false;
        setNotice(next.leased ? null : 'sendLeaseHeld');
        return next.leased;
      }, () => {
        if (lease.current === candidate) setNotice('offline');
        return false;
      });
      renewing.current = attempt;
      try { return await attempt; }
      finally { renewing.current = null; }
    };
    return () => { delete host.renewAccountLease; };
  }, []);

  const run = async (action: () => Promise<void>, fallback: Problem = 'unavailable') => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try { await action(); }
    catch (error) { setNotice(error instanceof RemoteSessionError ? 'signedOut' : fallback); }
    finally { setBusy(false); }
  };

  const accept = async (result: AccountState) => {
    setConnection(result);
    if (result.kind === 'refused') {
      setNotice(result.reason === 'invalid-address' ? 'invalid' : result.reason);
      return;
    }
    if (result.kind !== 'signed-in') return;
    const origin = new URL(address).origin;
    const [identity, registry] = await Promise.all([fetchAccount(`${origin}/v1/session`), fetchAccount(`${origin}/v1/account`)]);
    if (!identity.ok || !registry.ok) throw new RemoteSessionError(401);
    const display = await identity.json() as { login?: unknown };
    const owner = await registry.json() as { id?: unknown };
    if (typeof display.login !== 'string' || typeof owner.id !== 'string' || !ID.test(owner.id)) throw new TypeError('account');
    const account = owner.id;
    const wrapped = await fetchAccount(`${origin}/v1/account/key-record`, { headers: { 'X-Caotang-Account': account } });
    if (wrapped.status === 404) {
      setNotice('missing');
      return;
    }
    if (!wrapped.ok) throw new Error('key-record');
    const record = await wrapped.json() as AccountKeyRecord;
    if (rotationPending(record)) {
      setNotice('rotating');
      return;
    }
    localStorage.setItem(ADDRESS, origin);
    setSavedAddress(origin);
    setSession({ origin, account, login: display.login, scope: await accountScope(origin, account), record });
  };

  const unlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const form = event.currentTarget;
    const passphrase = new FormData(form).get('passphrase');
    if (typeof passphrase !== 'string') return;
    void run(async () => {
      const master = await unlockAccountKeys({ accountId: session.account, record: session.record, passphrase, resolveKdf: kdf.resolve });
      form.reset();
      const registry = createHttpProjectRegistry({ origin: session.origin, accountId: session.account, fetch: fetchAccount });
      try {
        const rows = await registry.list();
        const projects: Project[] = [];
        let unreadable = false;
        for (const row of rows) {
          try {
            const key = await unwrapProjectKey(master, row.wrappedKey, row.id);
            const { name } = await openProjectRecord(key, { accountId: session.account, projectId: row.id }, row.record);
            projects.push({ row, name });
          } catch { unreadable = true; }
        }
        setUnlocked({ master, projects, unreadable });
      } catch (error) {
        setNotice(error instanceof RemoteSessionError ? 'signedOut' : 'listFailed');
      }
    }, 'wrongPassphrase');
  };

  const leave = useCallback(async (): Promise<boolean> => {
    if (leaving.current) return leaving.current;
    const closing = (async () => {
      const target = frame.current?.contentWindow as AccountStudioWindow | null | undefined;
      if (target?.closeAccountProject && !await target.closeAccountProject()) {
        setNotice('closeRefused');
        return false;
      }
      const previous = lease.current;
      lease.current = null;
      setActive(null);
      setBlocked(null);
      if (previous) {
        const timeout = AbortSignal.timeout(2000);
        await Promise.race([
          previous.release().catch(() => undefined),
          new Promise<void>((resolve) => timeout.addEventListener('abort', () => resolve(), { once: true })),
        ]);
      }
      return true;
    })();
    leaving.current = closing;
    try { return await closing; }
    finally { leaving.current = null; }
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== ACCOUNT_ORIGIN || event.source !== frame.current?.contentWindow) return;
      if (event.data === 'account-project-failed') setNotice('openFailed');
      if (event.data === 'account-project-back') void leave();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [leave]);

  const open = (project: Project, mode: 'edit' | 'read', takeover = false) => run(async () => {
    if (!unlocked || !session) return;
    const projectId = project.row.id;
    const key = await importProjectKey(await unwrapProjectKey(unlocked.master, project.row.wrappedKey, projectId));
    if (mode === 'edit') {
      const candidate = createShellLease(projectId, createHttpLease({
        origin: session.origin, projectId, device, accountId: session.account, fetch: fetchAccount,
      }), LEASE_HEARTBEAT_MS, () => { setNotice('signedOut'); });
      if (!(await candidate.take({ takeover })).leased) {
        setBlocked(project);
        return;
      }
      lease.current = candidate;
      candidate.subscribe(() => {
        if (lease.current !== candidate || candidate.state().leased || renewing.current) return;
        if (candidate.expired()) {
          setNotice('offline');
        } else {
          void leave().then((closed) => { if (closed) setBlocked(project); });
        }
      });
    }
    setBlocked(null);
    setActive({ kind: 'account-project', origin: session.origin, account: session.account, scope: session.scope, language,
      project: mode === 'edit' ? { projectId, device, key, mode } : { projectId, key, mode },
    });
  }, 'openFailed');

  const signOut = () => run(async () => {
    if (!await leave()) return;
    kdf.close();
    if ((await native.signOut()).kind !== 'signed-out') {
      setNotice('signOutFailed');
      return;
    }
    setConnection({ kind: 'signed-out' });
    setSession(null);
    setUnlocked(null);
  });

  if (active) return <div className="account-studio">
    <header>
      <Button className="button" disabled={busy} onClick={() => run(async () => { await leave(); })}>{words.projects}</Button>
      <div className="account-recovery" data-recovery-notice={notice === 'closeRefused' || notice === 'sendLeaseHeld' || undefined}>
        {notice && <p role="status">{words[notice]}</p>}
        <div id="account-recovery-actions" />
      </div>
    </header>
    <iframe ref={frame} src="./studio.html" title={words.studio} onLoad={() => frame.current?.contentWindow?.postMessage(active, ACCOUNT_ORIGIN)} />
  </div>;

  return <main className="account-window">
    <section className="account-paper">
      <h1 ref={heading} tabIndex={-1}>{connection.kind === 'waiting' ? words.waiting : session && !unlocked ? words.unlock : words.title}</h1>
      {notice && <p role="alert">{words[notice]}</p>}
      {session ? <div className="account-actions"><bdi>{session.login}</bdi><Button className="button is-quiet" disabled={busy} onClick={signOut}>{words.signOut}</Button></div> : null}
      {connection.kind === 'waiting' ? <>
        <p>{words.match}</p><p className="account-code"><code>{connection.code}</code></p>
        <div className="account-actions">
          <Button className="button is-primary" disabled={busy} onClick={() => run(async () => accept(await native.check()))}>{words.check}</Button>
          <Button className="button is-quiet" disabled={busy} onClick={() => run(async () => accept(await native.cancel()))}>{words.cancel}</Button>
        </div>
      </> : !session ? <>
        <p>{words.intro}</p>
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => accept(await native.begin(address))); }}>
          <Field name="account-address">
            <FieldLabel>{words.address}</FieldLabel>
            <Input type="url" value={address} onChange={(event) => setAddress(event.currentTarget.value)} required disabled={busy} />
            <FieldDescription>{words.addressHelp}</FieldDescription>
          </Field>
          <div className="account-actions">
            <Button className="button is-primary" type="submit" disabled={busy}>{words.connect}</Button>
            {savedAddress !== '' && address === savedAddress && <Button className="button is-quiet" disabled={busy} onClick={() => run(async () => {
              const restored = await native.restore(address);
              if (restored.kind === 'signed-out') setNotice('noSavedConnection');
              else await accept(restored);
            })}>{words.restore}</Button>}
            {connection.kind === 'signed-in' && <Button className="button is-quiet" disabled={busy} onClick={signOut}>{words.signOut}</Button>}
          </div>
        </form>
      </> : !unlocked ? <form onSubmit={unlock}>
        <Field name="passphrase">
          <FieldLabel>{words.passphrase}</FieldLabel>
          <Input name="passphrase" type="password" autoComplete="current-password" required disabled={busy} />
          <FieldDescription>{words.unlockHelp}</FieldDescription>
        </Field>
        <Button className="button is-primary" type="submit" disabled={busy}>{words.unlock}</Button>
      </form> : <>
        {blocked && <div className="account-blocked" role="status">
          <p><bdi>{blocked.name}</bdi> — {words.elsewhere}</p>
          <div className="account-actions">
            <Button className="button" disabled={busy} onClick={() => open(blocked, 'read')}>{words.read}</Button>
            <Button className="button" disabled={busy} onClick={() => open(blocked, 'edit', true)}>{words.takeover}</Button>
          </div>
        </div>}
        {unlocked.unreadable && <p role="status">{words.unreadable}</p>}
        {unlocked.projects.length === 0 ? <p>{words.noProjects}</p> : <ul className="account-projects">
          {unlocked.projects.map((project) => <li key={project.row.id}>
            <h2><bdi>{project.name}</bdi></h2>
            <div className="account-actions">
              <Button className="button" disabled={busy} onClick={() => open(project, 'edit')}>{words.edit}</Button>
              <Button className="button is-quiet" disabled={busy} onClick={() => open(project, 'read')}>{words.read}</Button>
            </div>
          </li>)}
        </ul>}
      </>}
    </section>
  </main>;
}

const native = bridge(window);
const root = document.getElementById('root');
document.documentElement.lang = language;
if (native && root) createRoot(root).render(<AccountWindow native={native} />);
