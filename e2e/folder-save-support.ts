import type { Page } from '@playwright/test';

export async function holdFolderSave(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = globalThis as unknown as {
      showDirectoryPicker: () => Promise<unknown>;
      folderPickerCalls: number;
      releaseFolderPicker: () => void;
      releaseFolderWrite: () => void;
      FileSystemFileHandle: { prototype: { name: string; createWritable: (...args: unknown[]) => Promise<unknown> } };
    };
    let releasePicker = (): void => {};
    let releaseWrite = (): void => {};
    const picking = new Promise<void>((resolve) => { releasePicker = resolve; });
    const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
    host.folderPickerCalls = 0;
    host.releaseFolderPicker = releasePicker;
    host.releaseFolderWrite = releaseWrite;
    host.showDirectoryPicker = async () => {
      host.folderPickerCalls += 1;
      await picking;
      return (await navigator.storage.getDirectory()).getDirectoryHandle('dialog-flow-folder', { create: true });
    };
    const original = host.FileSystemFileHandle.prototype.createWritable;
    host.FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (this.name === 'caotang.json') await writing;
      return original.apply(this, args);
    };
  });
}

export async function releaseFolderPicker(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { releaseFolderPicker(): void }).releaseFolderPicker());
}

export async function releaseFolderWrite(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { releaseFolderWrite(): void }).releaseFolderWrite());
}
