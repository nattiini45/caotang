import { contextBridge, ipcRenderer } from 'electron';
import type { AccountBridge } from './account-contract.cjs';

const account: AccountBridge = {
  configuredOrigin: () => ipcRenderer.invoke('account:configured-origin'),
  restore: (origin) => ipcRenderer.invoke('account:restore', origin),
  begin: (origin) => ipcRenderer.invoke('account:begin', origin),
  check: () => ipcRenderer.invoke('account:check'),
  cancel: () => ipcRenderer.invoke('account:cancel'),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  request: (request) => ipcRenderer.invoke('account:request', request),
  abort: (id) => { void ipcRenderer.invoke('account:abort', id); },
};

contextBridge.exposeInMainWorld('caotangAccount', account);
