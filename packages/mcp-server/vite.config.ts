import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The bundle build: `src/bin.ts` to `dist/caotang-mcp.mjs`, one file a plain Node can run.
 *
 * The workspace packages are TypeScript sources whose imports end in `.js`, which Node
 * cannot resolve on its own, and the SDK's own dependencies are inlined with them, so
 * `noExternal` is true. Node's built-in modules are left as imports, which is what
 * Vite's server-side build does for them already. The shebang is added so the file can
 * be run directly as the `caotang-mcp` bin. Minification is off, so a reviewer can read
 * what is shipped. The PDFs' fallback fonts are not part of the build: the pack script
 * stages them in `fonts/` beside the bundle from their packages (scripts/pack-mcpb.mjs),
 * and `@caotang/pdf-fonts/node-loader` reads them from there.
 */
export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL('./src/bin.ts', import.meta.url)),
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'caotang-mcp.mjs',
        banner: '#!/usr/bin/env node',
        // The exporter loads DOCX and EPUB lazily. One file is the deliverable, so the lazy
        // chunks are inlined: a bundle that needs a sibling file is not a single runnable file.
        codeSplitting: false,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
