import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  define: { __CAOTANG_ACCOUNT_ORIGIN__: JSON.stringify(process.env['CAOTANG_ACCOUNT_ORIGIN'] ?? '') },
  build: {
    target: 'node24',
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/main.mts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'main.mjs',
    },
    rolldownOptions: { external: ['electron', '@parcel/watcher', /^node:/] },
  },
});
