import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

/**
 * The bundle build: `src/bin.ts` to `dist/caotang.mjs`, one file a plain Node can run (the same build as `caotang-mcp`: the workspace
 * packages and the MCP SDK are inlined, the lazy chunks are inlined, minification is off, and the shebang makes it a bin).
 *
 * The PDFs' fallback fonts are not code, so they sit beside the bundle in `fonts/`, where `@caotang/pdf-fonts/node-loader` looks first
 * (packages/pdf-fonts/src/node-loader.ts). Without them a screenplay PDF with Chinese, Japanese, Korean, emoji, Arabic, Hebrew or
 * Devanagari text fails to compile from this command.
 */
const FONT_FILES = [
  '@caotang/font-noto-cjk/NotoSansMonoCJKsc-Regular.woff',
  '@caotang/font-noto-emoji/NotoEmoji-Regular.woff',
  '@caotang/font-noto-arabic/NotoSansArabic-Regular.ttf',
  '@caotang/font-noto-hebrew/NotoSansHebrew-Regular.ttf',
  '@caotang/font-noto-devanagari/NotoSansDevanagari-Regular.ttf',
];

function fallbackFonts(): Plugin {
  return {
    name: 'caotang-fallback-fonts',
    generateBundle() {
      const resolve = createRequire(import.meta.url).resolve;
      for (const font of FONT_FILES) {
        this.emitFile({ type: 'asset', fileName: `fonts/${basename(font)}`, source: readFileSync(resolve(font)) });
      }
    },
  };
}

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
        entryFileNames: 'caotang.mjs',
        banner: '#!/usr/bin/env node',
        codeSplitting: false,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
