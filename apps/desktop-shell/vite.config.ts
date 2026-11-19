import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node24',
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/main.mts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'main.mjs',
    },
    rolldownOptions: { external: ['electron', /^node:/] },
  },
});
