import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './folder-contract.cjs';
import type { NativeFolderChange } from './folder-contract.cjs';
import type { EgressChunk, EgressEnd } from './egress-contract.cjs';
import type { IpcRendererEvent } from 'electron';

const bridge: DesktopBridge = {
  version: 3,
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
    watch: (id) => ipcRenderer.invoke('folders:watch', id),
    unwatch: (subscription) => ipcRenderer.invoke('folders:unwatch', subscription),
    onChanged: (listener) => {
      const notify = (_event: IpcRendererEvent, change: NativeFolderChange): void => listener(change);
      ipcRenderer.on('folders:changed', notify);
      return () => { ipcRenderer.off('folders:changed', notify); };
    },
  },
  net: {
    configure: (origins) => ipcRenderer.invoke('net:configure', origins),
    start: (spec) => ipcRenderer.invoke('net:start', spec),
    abort: (id) => ipcRenderer.invoke('net:abort', id),
    onChunk: (listener) => {
      const notify = (_event: IpcRendererEvent, chunk: EgressChunk): void => listener(chunk);
      ipcRenderer.on('net:chunk', notify);
      return () => { ipcRenderer.off('net:chunk', notify); };
    },
    onEnd: (listener) => {
      const notify = (_event: IpcRendererEvent, end: EgressEnd): void => listener(end);
      ipcRenderer.on('net:end', notify);
      return () => { ipcRenderer.off('net:end', notify); };
    },
  },
};
contextBridge.exposeInMainWorld('caotangDesktop', bridge);
