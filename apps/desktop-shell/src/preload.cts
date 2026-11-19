import { contextBridge } from 'electron';

export interface DesktopBridge {
  readonly version: 1;
}

declare global {
  interface Window {
    readonly caotangDesktop?: DesktopBridge;
  }
}

const bridge: DesktopBridge = { version: 1 };
contextBridge.exposeInMainWorld('caotangDesktop', bridge);
