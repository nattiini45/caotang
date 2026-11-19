import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './folder-contract.cjs';

const bridge: DesktopBridge = {
  version: 2,
  folders: {
    pickFolder: (mode) => ipcRenderer.invoke('folders:pick', mode),
    recentFolders: () => ipcRenderer.invoke('folders:recent'),
    rememberFolder: (id) => ipcRenderer.invoke('folders:remember', id),
    forgetFolder: (id) => ipcRenderer.invoke('folders:forget', id),
    list: (id, path) => ipcRenderer.invoke('folders:list', id, path),
    read: (id, path) => ipcRenderer.invoke('folders:read', id, path),
    write: (id, path, bytes) => ipcRenderer.invoke('folders:write', id, path, bytes),
    mkdir: (id, path) => ipcRenderer.invoke('folders:mkdir', id, path),
    remove: (id, path) => ipcRenderer.invoke('folders:remove', id, path),
  },
};
contextBridge.exposeInMainWorld('caotangDesktop', bridge);
