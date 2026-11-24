import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './folder-contract.cjs';
import type { NativeFolderChange } from './folder-contract.cjs';
import type { EgressChunk, EgressEnd } from './egress-contract.cjs';
import type { McpHostStatus } from './mcp-contract.cjs';
import type { NativeCommand, NativeShellState, NativeWindowState, SaveRequest } from './os-contract.cjs';
import type { IpcRendererEvent } from 'electron';

const bridge: DesktopBridge = {
  version: 6,
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
  vault: {
    available: () => ipcRenderer.invoke('vault:available'),
    put: (id, payload) => ipcRenderer.invoke('vault:put', id, payload),
    putHeaders: (id, headers) => ipcRenderer.invoke('vault:putHeaders', id, headers),
    remove: (id) => ipcRenderer.invoke('vault:remove', id),
    has: (id) => ipcRenderer.invoke('vault:has', id),
    revision: (id) => ipcRenderer.invoke('vault:revision', id),
    restore: (id) => ipcRenderer.invoke('vault:restore', id),
    headers: (id) => ipcRenderer.invoke('vault:headers', id),
    keyState: (id) => ipcRenderer.invoke('vault:keyState', id),
  },
  mcp: {
    start: (folderId, allowWrites) => ipcRenderer.invoke('mcp:start', folderId, allowWrites),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    status: () => ipcRenderer.invoke('mcp:status'),
    pause: () => ipcRenderer.invoke('mcp:pause'),
    resume: () => ipcRenderer.invoke('mcp:resume'),
    onStatus: (listener) => {
      const notify = (_event: IpcRendererEvent, status: McpHostStatus): void => listener(status);
      ipcRenderer.on('mcp:status', notify);
      ipcRenderer.send('mcp:subscribe');
      return () => {
        ipcRenderer.off('mcp:status', notify);
        // The main process holds one entry per page; a page that stops listening says so rather than leaving it there.
        ipcRenderer.send('mcp:unsubscribe');
      };
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
