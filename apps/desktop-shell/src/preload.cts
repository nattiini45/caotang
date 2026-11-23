import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './folder-contract.cjs';
import type { NativeFolderChange } from './folder-contract.cjs';
import type { NativeCommand, NativeShellState, NativeWindowState, SaveRequest } from './os-contract.cjs';
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
  os: {
    timeZone: () => ipcRenderer.invoke('os:timezone'),
    saveFile: (request: SaveRequest) => ipcRenderer.invoke('os:save', request),
    takeCommands: () => ipcRenderer.invoke('os:commands'),
    onCommand: (listener) => {
      const notify = (_event: IpcRendererEvent, command: NativeCommand): void => listener(command);
      ipcRenderer.on('os:command', notify);
      return () => { ipcRenderer.off('os:command', notify); };
    },
    publish: (state: NativeShellState) => ipcRenderer.invoke('os:publish', state),
    windowState: () => ipcRenderer.invoke('os:window-state'),
    onWindowState: (listener) => {
      const notify = (_event: IpcRendererEvent, state: NativeWindowState): void => listener(state);
      ipcRenderer.on('os:window-state', notify);
      return () => { ipcRenderer.off('os:window-state', notify); };
    },
  },
};
contextBridge.exposeInMainWorld('caotangDesktop', bridge);
