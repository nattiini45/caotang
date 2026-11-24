import type { IpcMainInvokeEvent } from 'electron';

/**
 * Whether an IPC call came from the studio's own top frame at the shell's entry URL (desktop.md §Runtime and trust boundary).
 * Every handler in this shell asks this first — the folder calls, the provider port, the vault and the OS integration — because
 * the preload exists in every frame the page can make, and a frame that is not the studio, a nested one or a document a link put
 * there, is answered as a refusal and never runs anything.
 */
export function fromStudioFrame(event: IpcMainInvokeEvent, entryUrl: string): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && frame.url === entryUrl;
}
