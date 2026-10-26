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
 * Devanagari text fails to compile from this command. The WebP decoder's `webp_dec.wasm` sits beside the bundle too, where
 * `@caotang/exporter/picture-transcoder-node` looks first; without it a contact sheet shows a WebP picture as its caption.
 */
const FONT_FILES = [
  '@caotang/font-noto-cjk/NotoSansMonoCJKsc-Regular.woff',
  '@caotang/font-noto-cjk/NotoSansMonoCJKsc-Regular-common.woff',
  '@caotang/font-noto-emoji/NotoEmoji-Regular.woff',
  '@caotang/font-noto-emoji/NotoEmoji-Regular-common.woff',
  '@caotang/font-noto-arabic/NotoSansArabic-Regular.ttf',
  '@caotang/font-noto-hebrew/NotoSansHebrew-Regular.ttf',
  '@caotang/font-noto-devanagari/NotoSansDevanagari-Regular.ttf',
];

const WEBP_DECODER = '@jsquash/webp/codec/dec/webp_dec.wasm';

function fallbackFonts(): Plugin {
  return {
    name: 'caotang-fallback-fonts',
    generateBundle() {
      const resolve = createRequire(import.meta.url).resolve;
      for (const font of FONT_FILES) {
        this.emitFile({ type: 'asset', fileName: `fonts/${basename(font)}`, source: readFileSync(resolve(font)) });
      }
      this.emitFile({ type: 'asset', fileName: basename(WEBP_DECODER), source: readFileSync(resolve(WEBP_DECODER)) });
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
