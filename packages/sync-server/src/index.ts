import { DurableObject } from 'cloudflare:workers';

export interface SyncServerBindings {
  ASSETS: Fetcher;
  ACCOUNT_HUBS: DurableObjectNamespace<AccountHub>;
  PUBLIC_ORIGIN: string;
  ALLOWED_GITHUB_LOGINS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

type Identity = { id: string; login: string };
type Ticket = { purpose: 'oauth' | 'session'; origin: string; expires: number; state?: string; verifier?: string; identity?: Identity };
const SESSION_COOKIE = '__Host-caotang-session';
const OAUTH_COOKIE = '__Host-caotang-oauth';
const encoder = new TextEncoder();
const PROFILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Attachment = { expires: number; profile?: string; connectedAt?: number };

function presenceProfile(url: URL): string | null | false {
  const values = url.searchParams.getAll('presence');
  if (values.length === 0) return null;
  return values.length === 1 && PROFILE.test(values[0]!) ? values[0]!.toLowerCase() : false;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
}

function cookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

function readCookie(request: Request, name: string): string {
  const values = (request.headers.get('Cookie') ?? '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function authenticationJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Authentication unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) throw new Error('Authentication response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function sign(ticket: Ticket, env: SyncServerBindings): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(ticket)));
  const mac = await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
}

async function verify(value: string, purpose: Ticket['purpose'], env: SyncServerBindings): Promise<Ticket | null> {
  if (value.length > 4096) return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), decode(mac), encoder.encode(payload))) return null;
    const ticket: Ticket = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (ticket.purpose !== purpose || ticket.origin !== env.PUBLIC_ORIGIN || !Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now()) return null;
    return ticket;
  } catch {
    return null;
  }
}

function allowed(identity: unknown, env: SyncServerBindings): identity is Identity {
  return identity !== null && typeof identity === 'object' && 'id' in identity && typeof identity.id === 'string' && /^github:[1-9]\d*$/.test(identity.id)
    && 'login' in identity && typeof identity.login === 'string' && env.ALLOWED_GITHUB_LOGINS.split(',').map((login) => login.trim().toLowerCase()).includes(identity.login.toLowerCase());
}

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function configured(env: SyncServerBindings): boolean {
  try {
    const origin = new URL(env.PUBLIC_ORIGIN);
    return origin.protocol === 'https:' && origin.origin === env.PUBLIC_ORIGIN && encoder.encode(env.SESSION_SECRET).length >= 32
      && Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.ALLOWED_GITHUB_LOGINS.trim());
  } catch {
    return false;
  }
}

async function startLogin(env: SyncServerBindings): Promise<Response> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.PUBLIC_ORIGIN}/v1/auth/github/callback`,
    state, code_challenge: challenge, code_challenge_method: 'S256', scope: '', allow_signup: 'false' }).toString();
  const ticket = await sign({ purpose: 'oauth', origin: env.PUBLIC_ORIGIN, expires: Date.now() + 600_000, state, verifier }, env);
  return new Response(null, { status: 302, headers: { Location: url.href, 'Set-Cookie': cookie(OAUTH_COOKIE, ticket, 600), 'Cache-Control': 'no-store' } });
}

async function finishLogin(request: Request, env: SyncServerBindings): Promise<Response> {
  let response: Response;
  try {
    const url = new URL(request.url);
    const ticket = await verify(readCookie(request, OAUTH_COOKIE), 'oauth', env);
    const code = url.searchParams.get('code');
    if (!ticket?.state || !ticket.verifier || url.searchParams.get('state') !== ticket.state || !code || code.length > 1024 || url.searchParams.has('error')) {
      response = reply(400, 'Sign-in could not be verified. Start sign-in again.');
    } else {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
          redirect_uri: `${env.PUBLIC_ORIGIN}/v1/auth/github/callback`, code_verifier: ticket.verifier }),
      });
      const token = await authenticationJson(tokenResponse);
      if (!token || typeof token !== 'object' || !('access_token' in token) || 'error' in token || typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 4096) throw new Error('OAuth refused');
      const userResponse = await fetch('https://api.github.com/user', {
        redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'Caotang-sync-server', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      const user = await authenticationJson(userResponse);
      const identity = user && typeof user === 'object' && 'id' in user && 'login' in user && Number.isSafeInteger(user.id) && Number(user.id) > 0 && typeof user.login === 'string'
        ? { id: `github:${user.id}`, login: user.login } : undefined;
      if (!allowed(identity, env)) {
        response = reply(403, 'This GitHub login is not invited. Contact the server operator.');
      } else {
        const session = await sign({ purpose: 'session', origin: env.PUBLIC_ORIGIN, expires: Date.now() + 28_800_000, identity }, env);
        response = new Response(null, { status: 302, headers: { Location: `${env.PUBLIC_ORIGIN}/`, 'Set-Cookie': cookie(SESSION_COOKIE, session, 28_800), 'Cache-Control': 'no-store' } });
      }
    }
  } catch {
    response = reply(502, 'Sign-in is unavailable. Try signing in again.');
  }
  response.headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
  return response;
}

export default {
  async fetch(request: Request, env: SyncServerBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return request.method === 'GET' ? Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } }) : reply(405, 'Use GET for the health check.');
    if (!url.pathname.startsWith('/v1/')) return env.ASSETS.fetch(request);
    if (!configured(env)) return reply(503, 'Sign-in is not configured. Contact the server operator.');
    if (url.origin !== env.PUBLIC_ORIGIN) return reply(403, 'Use the configured server address.');
    const crossOrigin = request.headers.get('Origin') !== env.PUBLIC_ORIGIN;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && crossOrigin) return reply(403, 'This request must come from the app.');
    if (url.pathname === '/v1/auth/github') return request.method === 'GET' ? startLogin(env) : reply(405, 'Use GET to begin sign-in.');
    if (url.pathname === '/v1/auth/github/callback') return request.method === 'GET' ? finishLogin(request, env) : reply(405, 'Use GET to finish sign-in.');
    const ticket = await verify(readCookie(request, SESSION_COOKIE), 'session', env);
    if (!ticket || !allowed(ticket.identity, env)) return reply(401, 'Sign in to continue.');
    if (url.pathname === '/v1/session') return request.method === 'GET' ? Response.json(ticket.identity, { headers: { 'Cache-Control': 'no-store' } }) : reply(405, 'Use GET to read the session.');
    if (url.pathname === '/v1/auth/logout') return request.method === 'POST' ? new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0), 'Cache-Control': 'no-store' } }) : reply(405, 'Use POST to sign out.');
    if (url.pathname === '/v1/live') {
      if (request.method !== 'GET') return reply(405, 'Use GET to connect.');
      if (crossOrigin) return reply(403, 'This connection must come from the app.');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return reply(426, 'Connect with a WebSocket.');
      const profile = presenceProfile(url);
      if (profile === false) return reply(400, 'Use one random browser-profile UUID for presence.');
      const headers = new Headers({ Upgrade: 'websocket', 'X-Session-Expires': String(ticket.expires) });
      if (profile) headers.set('X-Presence-Profile', profile);
      return env.ACCOUNT_HUBS.getByName(ticket.identity.id).fetch(new Request(`${env.PUBLIC_ORIGIN}/connect`, { headers }));
    }
    if (url.pathname === '/v1/live/ping') {
      if (request.method !== 'POST') return reply(405, 'Use POST to send a ping.');
      const profile = presenceProfile(url);
      if (profile === false) return reply(400, 'Use one random browser-profile UUID for presence.');
      await env.ACCOUNT_HUBS.getByName(ticket.identity.id).ping(profile ?? undefined);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    return reply(404, 'This API route does not exist.');
  },
};

export class AccountHub extends DurableObject<SyncServerBindings> {
  constructor(ctx: DurableObjectState, env: SyncServerBindings) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    const expires = Number(request.headers.get('X-Session-Expires'));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !Number.isSafeInteger(expires) || expires <= Date.now()) return reply(400, 'A verified WebSocket connection is required.');
    const profile = request.headers.get('X-Presence-Profile') ?? undefined;
    if (profile !== undefined && !PROFILE.test(profile)) return reply(400, 'Use a random browser-profile UUID for presence.');
    const removed = new Set<string>();
    const before = this.active(removed);
    const joined = profile && !before.some((socket) => this.attachment(socket)?.profile === profile);
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ expires, ...(profile ? { profile, connectedAt: Date.now() } : {}) });
    this.ctx.acceptWebSocket(pair[1]);
    const sockets = this.publish([...before, pair[1]], joined ? 'joined' : 'snapshot', new Set(profile ? [profile] : []), removed);
    await this.schedule(sockets);
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Cache-Control': 'no-store' } });
  }

  private attachment(socket: WebSocket): Attachment | null {
    return socket.deserializeAttachment();
  }

  private retire(socket: WebSocket, code: number, reason: string, removed: Set<string>): void {
    const profile = this.attachment(socket)?.profile;
    if (profile) removed.add(profile);
    socket.serializeAttachment(null);
    try { socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); }
    catch { return; }
  }

  private active(removed: Set<string>, exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      if (socket === exclude || socket.readyState !== WebSocket.OPEN) return false;
      const attachment = this.attachment(socket);
      if (!attachment || attachment.expires <= Date.now()) {
        this.retire(socket, 1008, 'Sign in again.', removed);
        return false;
      }
      if (attachment.profile) {
        const seen = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.connectedAt ?? 0;
        if (seen + 60_000 <= Date.now()) {
          this.retire(socket, 1008, 'Reconnect to continue.', removed);
          return false;
        }
      }
      return true;
    });
  }

  private publish(sockets: WebSocket[], change: 'snapshot' | 'joined' | 'activity', changed: Set<string>, removed: Set<string>): WebSocket[] {
    while (sockets.length) {
      const profiles = new Set(sockets.map((socket) => this.attachment(socket)?.profile).filter((profile) => profile !== undefined));
      const failed = new Set<WebSocket>();
      const nextRemoved = new Set<string>();
      for (const socket of sockets) {
        const profile = this.attachment(socket)?.profile;
        if (!profile) continue;
        const events: ('snapshot' | 'joined' | 'left' | 'activity')[] = [];
        if ([...removed].some((value) => value !== profile && !profiles.has(value))) events.push('left');
        if (change !== 'snapshot' && [...changed].some((value) => value !== profile)) events.push(change);
        if (events.length === 0) events.push('snapshot');
        try {
          for (const event of events) socket.send(JSON.stringify({ type: 'presence', peers: profiles.size - 1, change: event }));
        } catch {
          this.retire(socket, 1011, 'Reconnect to continue.', nextRemoved);
          failed.add(socket);
        }
      }
      if (failed.size === 0) return sockets;
      sockets = sockets.filter((socket) => !failed.has(socket));
      removed = nextRemoved;
      change = 'snapshot';
    }
    return sockets;
  }

  private async schedule(sockets: WebSocket[]): Promise<void> {
    const present = sockets.map((socket) => this.attachment(socket)).filter((value) => value?.profile);
    if (present.length === 0) { await this.ctx.storage.deleteAlarm(); return; }
    const next = Math.min(Date.now() + 30_000, ...present.map((value) => value!.expires));
    const existing = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(existing !== null && existing > Date.now() ? Math.min(existing, next) : next);
  }

  override async alarm(): Promise<void> {
    const removed = new Set<string>();
    const sockets = this.publish(this.active(removed), 'snapshot', new Set(), removed);
    await this.schedule(sockets);
  }

  async ping(profile?: string): Promise<void> {
    const removed = new Set<string>();
    const sockets = this.active(removed);
    for (const socket of sockets) {
      try { socket.send(JSON.stringify({ type: 'ping' })); }
      catch { this.retire(socket, 1011, 'Reconnect to continue.', removed); }
    }
    const active = this.active(removed);
    const hasProfile = profile && active.some((socket) => this.attachment(socket)?.profile === profile);
    const published = this.publish(active, hasProfile ? 'activity' : 'snapshot', new Set(hasProfile ? [profile] : []), removed);
    await this.schedule(published);
  }

  override async webSocketMessage(socket: WebSocket): Promise<void> {
    await this.depart(socket, 1008, 'Only heartbeat messages are accepted.');
  }

  private async depart(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = this.attachment(socket);
    const removed = new Set<string>();
    this.retire(socket, code, reason, removed);
    if (!attachment) return;
    const sockets = this.publish(this.active(removed, socket), 'snapshot', new Set(), removed);
    await this.schedule(sockets);
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    await this.depart(socket, code, reason);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.depart(socket, 1011, 'Reconnect to continue.');
  }
}
