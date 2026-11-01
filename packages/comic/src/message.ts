import type { MessageRef } from '@caotang/i18n';

export type { MessageRef };

/**
 * Messages here avoid ICU plural syntax and apostrophes so {@link renderMessage} reads them correctly without a
 * message library; a catalogue entry for the same id may still be richer.
 */
export function msg(id: string, message: string, values?: Record<string, string | number>): MessageRef {
  return values === undefined ? { id, message } : { id, message, values };
}

/** The English sentence with its named values filled in — what the CLI, the MCP server and the SDK show. */
export function renderMessage(ref: MessageRef): string {
  const values = ref.values ?? {};
  return ref.message.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
