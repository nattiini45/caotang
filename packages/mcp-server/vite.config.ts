import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

/**
 * The screenplay PDF's fallback fonts, the CJK one and the emoji one, which the screenplay package reads from `./fonts/`
 * beside the running module.
 */
const FALLBACK_FONTS = ['fonts/NotoSansMonoCJKsc-Regular.otf', 'fonts/NotoEmoji-Regular.ttf'];

/**
 * Emits the fallback fonts as `dist/fonts/NotoSansMonoCJKsc-Regular.otf` and `dist/fonts/NotoEmoji-Regular.ttf`. A server
 * build leaves each font's `new URL('./fonts/…', import.meta.url)` as it is, so the files must sit in `fonts/` beside the
 * bundle. Each is read only when a screenplay PDF holds a character Courier Prime cannot print, or an emoji, so the bundle
 * still runs without them for everything else. test/binary.test.ts builds the bundle and checks both: the files in
 * `dist/fonts/`, and the URLs left as written.
 */
function fallbackFonts(): Plugin {
  return {
    name: 'caotang-fallback-fonts',
    apply: 'build',
    generateBundle() {
      for (const fileName of FALLBACK_FONTS) {
        const source = readFileSync(fileURLToPath(new URL(`../screenplay/src/${fileName}`, import.meta.url)));
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}

/**
 * The bundle build: `src/bin.ts` to `dist/caotang-mcp.mjs`, one file a plain Node can run.
 *
 * The workspace packages are TypeScript sources whose imports end in `.js`, which Node
 * cannot resolve on its own, and the SDK's own dependencies are inlined with them, so
 * `noExternal` is true. Node's built-in modules are left as imports, which is what
 * Vite's server-side build does for them already. The shebang is added so the file can
 * be run directly as the `caotang-mcp` bin. Minification is off, so a reviewer can read
 * what is shipped. The files beside it are the screenplay PDF's fallback fonts (fallbackFonts below).
 */
export default defineConfig({
  plugins: [fallbackFonts()],
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
