/**
 * Requests between Modern's slots (modern-interface.md §8.9). The slots are independent components (slots.ts), each built by its own
 * issue, so one that asks another for something does it through a channel here instead of through `Workspace`: **Search** in the
 * bottom ornament (#306) opens the palette (#310); the palette asks Scene info (#308), the sidebar (#307) and the views (#306) to show
 * themselves. A slot listens while it is mounted. `send` answers whether a listener took the request, so the asker can fall back to
 * the regions' own handler while the slot that would take it is not built yet.
 *
 * Plain modules on purpose: no React context, so a slot needs no provider above it and a test can send a request directly.
 */

import type { RailTab } from '../regions.js';
import type { PaletteView } from '../../../app/palette-model.js';

export interface Channel<T> {
  /** Sends the request to every listener; true when at least one took it. */
  send(request: T): boolean;
  /** Listens until the returned function is called. */
  listen(listener: (request: T) => void): () => void;
}

export function createChannel<T>(): Channel<T> {
  const listeners = new Set<(request: T) => void>();
  return {
    send(request) {
      for (const listener of [...listeners]) listener(request);
      return listeners.size > 0;
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Open the palette. `opener` takes focus back when it closes; absent, the element focused at the time does. */
export interface PaletteRequest {
  readonly opener?: HTMLElement | null;
}

export const paletteChannel: Channel<PaletteRequest> = createChannel<PaletteRequest>();

/**
 * Opens the palette, as **Search** and Ctrl+K (Cmd+K) do. #306's Search button calls `openPalette(event.currentTarget)`. Answers
 * false while no palette is mounted (Classic, or a test's own slots).
 */
export function openPalette(opener?: HTMLElement | null): boolean {
  return paletteChannel.send(opener === undefined ? {} : { opener });
}

/** Show Scene info (#308 listens). */
export const sceneInfoChannel: Channel<Record<string, never>> = createChannel<Record<string, never>>();

/** Open the sidebar on a tab (#307 listens). */
export const sidebarChannel: Channel<{ readonly tab: RailTab }> = createChannel<{ readonly tab: RailTab }>();

/** Show a view on the page (#306 listens; the codex is a view in Modern). */
export const viewChannel: Channel<{ readonly view: PaletteView }> = createChannel<{ readonly view: PaletteView }>();

/** Open the **+ New** menu (#477 listens); Ctrl+Shift+N and the palette send it. */
export const newMenuChannel: Channel<Record<string, never>> = createChannel<Record<string, never>>();
