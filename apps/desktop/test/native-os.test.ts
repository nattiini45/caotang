/**
 * The page's side of the desktop shell (desktop.md §Native menus, §The tray and scheduled task runs, §The system timezone). None of
 * it needs a window: the bridge is a value the module reads, so a fake one is enough to hold the rules that only the desktop build
 * exercises — and to hold what the web build does without any of them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NativeCommand, NativeOsBridge } from '../../desktop-shell/src/os-contract.cjs';
import {
  nativeRefusalSentence,
  nativeTrayStatus,
  onNativeCommand,
  readNativeTimeZone,
  ticksCount,
  deviceTimeZone,
  publishNativeState,
  nativeShellState,
  studioTicks,
} from '../src/app/native-os.js';
import { saveExportFile } from '../src/app/native-save.js';
import { dayKeyIn } from '../src/app/session-progress.js';

function withBridge(os: Partial<NativeOsBridge>): void {
  (globalThis as { window?: unknown }).window = {
    caotangDesktop: {
      version: 3,
      folders: {},
      os: {
        timeZone: async () => 'Europe/Berlin',
        saveFile: async () => ({ ok: true, value: { saved: true } }),
        takeCommands: async () => [],
        onCommand: () => () => undefined,
        publish: async () => undefined,
        windowState: async () => 'visible' as const,
        onWindowState: () => () => undefined,
        ...os,
      },
    },
  };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = undefined;
  vi.restoreAllMocks();
});

describe('who may tick', () => {
  it('stops for a hidden tab and carries on for a window the tray is holding', () => {
    expect(ticksCount({ documentHidden: false, hiddenToTray: false })).toBe(true);
    expect(ticksCount({ documentHidden: true, hiddenToTray: false })).toBe(false);
    expect(ticksCount({ documentHidden: true, hiddenToTray: true })).toBe(true);
    expect(ticksCount({ documentHidden: false, hiddenToTray: true })).toBe(true);
  });

  it('reads the page\'s own visibility where there is no shell', () => {
    expect(studioTicks({ documentHidden: true })).toBe(false);
    expect(studioTicks({ documentHidden: false })).toBe(true);
  });
});

describe('the tray line', () => {
  it('never claims work a paused studio is not doing', () => {
    expect(nativeTrayStatus({ project: null, hiddenToTray: true })).toBe('No project is open, so scheduled tasks are paused.');
    expect(nativeTrayStatus({ project: 'Harbor Notebook', hiddenToTray: true }))
      .toBe('Harbor Notebook is open. Scheduled tasks keep running while Caotang is in the tray.');
    expect(nativeTrayStatus({ project: 'Harbor Notebook', hiddenToTray: false }))
      .toBe('Harbor Notebook is open. Scheduled tasks run while this window is open.');
  });

  it('carries the labels the shell puts on its own menu, and whether a project is open', () => {
    const state = nativeShellState({ project: null });
    expect(state.project).toBe(false);
    expect(state.labels.file).toBe('File');
    expect(state.labels.trayOpen).toBe('Open Caotang');
    expect(state.status).toBe('No project is open, so scheduled tasks are paused.');
  });
});

describe('what outside may ask for', () => {
  it('says what was refused, in sentences a writer can act on', () => {
    const sentences = [
      nativeRefusalSentence('link-route'),
      nativeRefusalSentence('link-unknown'),
      nativeRefusalSentence('folder-not-a-project'),
      nativeRefusalSentence('folder-unreadable'),
    ];
    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });

  it('delivers a command to the page and does nothing at all without a shell', () => {
    const heard: NativeCommand[] = [];
    onNativeCommand((command) => heard.push(command));
    expect(heard).toEqual([]);
    let received: ((command: NativeCommand) => void) | null = null;
    withBridge({
      onCommand: (listener) => {
        received = listener;
        return () => { received = null; };
      },
    });
    const stop = onNativeCommand((command) => heard.push(command));
    received?.({ kind: 'compile' });
    expect(heard).toEqual([{ kind: 'compile' }]);
    stop();
    expect(received).toBeNull();
  });

  it('publishes nothing when there is no shell, and the state when there is', async () => {
    expect(() => publishNativeState({ project: null })).not.toThrow();
    const seen: unknown[] = [];
    withBridge({ publish: async (state) => { seen.push(state); } });
    publishNativeState({ project: 'Harbor Notebook' });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ project: true });
  });
});

describe('the operating system\'s zone', () => {
  it('is read once from the shell and is absent in a browser', async () => {
    expect(deviceTimeZone()).toBeUndefined();
    withBridge({ timeZone: async () => 'Pacific/Auckland' });
    await readNativeTimeZone();
    expect(deviceTimeZone()).toBe('Pacific/Auckland');
  });

  it('counts the day on the writer\'s own clock, not the renderer\'s', () => {
    // 2026-11-23 23:30 UTC is already the 24th in Auckland and still the 23rd in Berlin.
    const instant = Date.parse('2026-11-23T23:30:00Z');
    expect(dayKeyIn('Pacific/Auckland', instant)).toBe('2026-11-24');
    expect(dayKeyIn('Europe/Berlin', instant)).toBe('2026-11-24');
    expect(dayKeyIn('America/Los_Angeles', instant)).toBe('2026-11-23');
    // A zone the platform does not know falls back to the device's own day rather than failing a count.
    expect(dayKeyIn('Not/AZone', instant)).toBe(dayKeyIn(undefined, instant));
  });
});

describe('saving a file', () => {
  it('writes where the writer chose, and loses nothing when they cancel', async () => {
    withBridge({ saveFile: async () => ({ ok: true, value: { saved: true } }) });
    await expect(saveExportFile(new Uint8Array([1]), 'Harbor.md', 'text/markdown')).resolves.toBe('saved');
    withBridge({ saveFile: async () => ({ ok: true, value: { saved: false } }) });
    await expect(saveExportFile(new Uint8Array([1]), 'Harbor.md', 'text/markdown')).resolves.toBe('cancelled');
    withBridge({ saveFile: async () => ({ ok: false, error: 'unavailable' }) });
    await expect(saveExportFile(new Uint8Array([1]), 'Harbor.docx', 'application/octet-stream')).resolves.toBe('unavailable');
    withBridge({ saveFile: async () => { throw new Error('the dialog went away'); } });
    await expect(saveExportFile(new Uint8Array([1]), 'Harbor.docx', 'application/octet-stream')).resolves.toBe('unavailable');
  });
});
