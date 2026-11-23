/**
 * One check, in one place: a call reaches the main process only from the studio's own top frame at the shell's address. A
 * frame inside it, another origin, or a page that navigated away never gets through.
 */

import type { IpcMainInvokeEvent } from 'electron';

export function fromStudioFrame(event: IpcMainInvokeEvent, entryUrl: string): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && frame.url === entryUrl;
}
