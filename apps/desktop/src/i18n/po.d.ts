/** The compiled message module the Vite plugin produces for a `.po` import (`@lingui/vite-plugin`, lingui.config.ts). */
declare module '*.po' {
  import type { Messages } from '@lingui/core';

  export const messages: Messages;
}
