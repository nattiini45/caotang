import { readFileSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, net, protocol, screen, session } from 'electron';

import { registerEgressIpc } from './egress.mjs';
import { registerFolderIpc } from './folders.mjs';
const ORIGIN = 'app://caotang';
const ENTRY = `${ORIGIN}/`;
const BUILD = resolve(import.meta.dirname, '../../desktop/dist');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: http: ws:",
  "worker-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

async function serveBuild(): Promise<void> {
  const root = await realpath(BUILD);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'caotang' || url.username || url.password || request.method !== 'GET') {
      return new Response(null, { status: 404 });
    }
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^(?:index\.html|THIRD-PARTY-NOTICES\.md|assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.test(path)) {
      return new Response(null, { status: 404 });
    }
    try {
      const file = await realpath(resolve(root, path));
      const fromRoot = relative(root, file);
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        return new Response(null, { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

async function openWindow(): Promise<void> {
  const statePath = join(app.getPath('userData'), 'window.json');
  const { width: availableWidth, height: availableHeight } = screen.getPrimaryDisplay().workAreaSize;
  let state: { width?: unknown; height?: unknown; maximized?: unknown };
  try {
    const saved: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    state = saved && typeof saved === 'object' ? saved : {};
  } catch {
    state = {};
  }
  const window = new BrowserWindow({
    width: Math.min(availableWidth, Number.isInteger(state.width) ? Math.max(480, Number(state.width)) : 1280),
    height: Math.min(availableHeight, Number.isInteger(state.height) ? Math.max(360, Number(state.height)) : 850),
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  if (state.maximized === true) window.maximize();
  window.on('close', () => {
    const { width, height } = window.getNormalBounds();
    try {
      writeFileSync(statePath, JSON.stringify({ width, height, maximized: window.isMaximized() }));
    } catch (error) {
      console.warn('Could not save window size.', error);
    }
  });
  await window.loadURL(ENTRY);
}

async function start(): Promise<void> {
  await serveBuild();
  await registerFolderIpc(app.getPath('userData'), ENTRY);
  registerEgressIpc(ENTRY);
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => (
    contents?.getURL() === ENTRY && origin === ORIGIN && allowed(permission)
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, grant, details) => {
    grant(contents.getURL() === ENTRY && details.requestingUrl === ENTRY && allowed(permission));
  });
  await openWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow().catch(fail);
  });
}

function fail(error: unknown): void {
  console.error('Could not open the Caotang web build. Run pnpm build from the repository root first.', error);
  app.exit(1);
}

if (app.commandLine.hasSwitch('no-sandbox')) {
  console.error('Caotang for desktop requires the Chromium sandbox.');
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app.whenReady().then(start).catch(fail);
}
