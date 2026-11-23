import { readFileSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, net, protocol, screen, session } from 'electron';

import { registerFolderIpc } from './folders.mjs';
import { registerOsIpc, type OsIntegration } from './os.mjs';

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

/** The one window. Closing it hides it to the tray while the tray exists, so the same window is what comes back. */
let mainWindow: BrowserWindow | null = null;
/** Set while the app is ending, so the close that ends it is not turned into a hide. */
let quitting = false;
let os: OsIntegration | null = null;
/** What the system handed this launch before the integration existed, in order: macOS delivers a link or a folder that opened the app before it is ready. */
const early: string[] = [];

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
      // The window that is closed to the tray is a hidden one, and a hidden renderer's timers are throttled unless this is off.
      // Scheduled task runs are the page's timers, so the tray would otherwise promise work that never happens
      // (desktop.md §The tray and scheduled task runs).
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  if (state.maximized === true) window.maximize();
  window.on('show', () => {
    os?.setWindowState('visible');
  });
  window.on('close', (event) => {
    const { width, height } = window.getNormalBounds();
    try {
      writeFileSync(statePath, JSON.stringify({ width, height, maximized: window.isMaximized() }));
    } catch (error) {
      console.warn('Could not save window size.', error);
    }
    if (quitting || os === null || !os.staysInTray()) return;
    // Closing leaves the studio running, so a scheduled task run can still happen and the tray can bring the window back. Quit is
    // the tray's own item, and it says so.
    event.preventDefault();
    window.hide();
    os.setWindowState('hidden-to-tray');
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(ENTRY);
}

/** Brings the one window back, opening it if it has gone. */
function showWindow(): void {
  // Held before the app is ready: the window `start` is about to open is the one to show, and a second one would be wrong.
  if (!app.isReady()) return;
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    void openWindow().catch(fail);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  os?.setWindowState('visible');
}

/**
 * Delivers what the system handed this launch or this moment: `caotang://` links and folders ("open with"), and nothing else. On
 * macOS a link arrives through `open-url` and a folder through `open-file`; on Windows and Linux both are arguments, so this is
 * where the second instance's are handed on too.
 */
function deliverAll(evidence: readonly string[]): void {
  // Before `start` has registered the integration, a delivery is held rather than dropped: on macOS `open-url` and `open-file` arrive
  // while the app is still starting, and a link that quit the app by doing nothing is the one failure a writer cannot diagnose.
  if (os === null) {
    early.push(...evidence);
    return;
  }
  for (const argument of evidence) void os.deliver(argument);
}

async function start(): Promise<void> {
  await serveBuild();
  const folders = await registerFolderIpc(app.getPath('userData'), ENTRY);
  os = registerOsIpc({
    entryUrl: ENTRY,
    own: [process.execPath, app.getAppPath()],
    folders,
    window: () => mainWindow,
    show: showWindow,
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  // The packages register the scheme for an installed app (`electron-builder.yml`'s `protocols`); this asks the running system to
  // point the scheme at this build as well, and only a packaged build asks: a development shell must not take the scheme over.
  if (app.isPackaged) app.setAsDefaultProtocolClient('caotang');
  // A link that launched the app is in this process's own arguments, and one that arrived while it was starting is in `early`: both
  // are queued inside the integration until the page asks for them.
  deliverAll(process.argv.slice(1));
  deliverAll(early.splice(0));
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => (
    contents?.getURL() === ENTRY && origin === ORIGIN && allowed(permission)
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, grant, details) => {
    grant(contents.getURL() === ENTRY && details.requestingUrl === ENTRY && allowed(permission));
  });
  await openWindow();
  app.on('activate', () => {
    showWindow();
  });
}

function fail(error: unknown): void {
  console.error('Could not open the Caotang web build. Run pnpm build from the repository root first.', error);
  app.exit(1);
}

// Heard before the app is ready, which is when macOS delivers them: the window may not exist yet, and a command waits for the page.
app.on('open-url', (event, url) => {
  event.preventDefault();
  showWindow();
  deliverAll([url]);
});
app.on('open-file', (event, path) => {
  event.preventDefault();
  showWindow();
  deliverAll([path]);
});

if (app.commandLine.hasSwitch('no-sandbox')) {
  console.error('Caotang for desktop requires the Chromium sandbox.');
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('second-instance', (_event, argv) => {
    showWindow();
    deliverAll(argv.slice(1));
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app.whenReady().then(start).catch(fail);
}
