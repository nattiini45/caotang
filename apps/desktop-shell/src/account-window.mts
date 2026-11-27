import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { accountOrigin, createAccountPort } from './account-port.mjs';
import { fromStudioFrame } from './ipc-guard.mjs';
import { openAccountVault } from './vault.mjs';

export const ACCOUNT_ORIGIN = 'app://account';
export const ACCOUNT_ENTRY = `${ACCOUNT_ORIGIN}/account/index.html`;
export const ACCOUNT_STUDIO = `${ACCOUNT_ORIGIN}/account/studio.html`;
declare const __CAOTANG_ACCOUNT_ORIGIN__: string;

export async function registerAccountWindow() {
  let window: BrowserWindow | null = null;
  const vault = await openAccountVault(app.getPath('userData'));
  const port = createAccountPort({ vault, openBrowser: (url) => shell.openExternal(url) });
  const handler = (name: string, run: (value: unknown) => unknown) => {
    ipcMain.handle(`account:${name}`, (event, value: unknown) => {
      if (window?.webContents !== event.sender || !fromStudioFrame(event, ACCOUNT_ENTRY)) return undefined;
      return run(value);
    });
  };
  handler('configured-origin', () => accountOrigin(__CAOTANG_ACCOUNT_ORIGIN__));
  handler('restore', port.restore);
  handler('begin', port.begin);
  handler('check', port.check);
  handler('cancel', port.cancel);
  handler('sign-out', port.signOut);
  handler('request', port.request);
  handler('abort', port.abort);

  return () => {
    if (window !== null) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    const next = new BrowserWindow({
      title: 'Caotang', width: 1200, height: 830, minWidth: 380, minHeight: 440,
      webPreferences: {
        preload: join(import.meta.dirname, 'account-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, backgroundThrottling: false,
      },
    });
    window = next;
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || event.url !== ACCOUNT_STUDIO) event.preventDefault();
    });
    next.webContents.on('will-redirect', (event) => event.preventDefault());
    next.on('closed', () => {
      port.reset();
      window = null;
    });
    void next.loadURL(ACCOUNT_ENTRY).catch(() => {
      next.destroy();
      dialog.showErrorBox('Caotang', 'The account window could not be opened.');
    });
  };
}
