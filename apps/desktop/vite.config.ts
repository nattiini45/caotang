import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lingui } from '@lingui/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The notices generator and the size budget are plain modules with types beside them (tools/*.d.mts).
import { BUDGET } from '../../tools/check-bundle-size.mjs';
import { generateNotices, NOTICES_FILE } from '../../tools/third-party-notices.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Writes THIRD-PARTY-NOTICES.md beside the build, so a copy of dist/ carries the notices of what it holds. MIT and
 * Apache-2.0 both require the notices to travel with copies of the software. The text comes from the lockfile, for the
 * production dependencies of this app (tools/third-party-notices.mjs), so it names what the build contains.
 */
function thirdPartyNotices(): Plugin {
  return {
    name: 'caotang-third-party-notices',
    apply: 'build',
    closeBundle() {
      const text = generateNotices({ root: REPO_ROOT, filters: ['./apps/desktop'] });
      writeFileSync(fileURLToPath(new URL(`dist/${NOTICES_FILE}`, import.meta.url)), text);
    },
  };
}

/** The nonce the dev server puts on the tags it injects itself. Dev only: the built app carries no nonce. */
const DEV_NONCE = 'caotang-dev';

/**
 * The dev server injects an inline script (React Fast Refresh's preamble) and inline styles (CSS modules as <style>
 * tags), and talks to its HMR socket. It marks its own tags with a nonce (html.cspNonce below), so the dev page runs the
 * policy in index.html with that nonce admitted and `ws:` added to connect-src — and nothing else relaxed, so a style
 * attribute or an inline script the app itself writes is refused in dev exactly as in the build.
 */
function devCsp(): Plugin {
  return {
    name: 'caotang-dev-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/, (_match, open: string, policy: string, close: string) => {
          const relaxed = policy
            .replace("script-src 'self'", `script-src 'self' 'nonce-${DEV_NONCE}'`)
            .replace("style-src 'self'", `style-src 'self' 'nonce-${DEV_NONCE}'`)
            .replace('connect-src *', 'connect-src * ws:');
          return `${open}${relaxed}${close}`;
        });
      },
    },
  };
}

/**
 * The path the build is served under. `/` by default, as the preview and the e2e suite serve it. The Pages workflow sets
 * CAOTANG_BASE=/app/, because caotang.app serves the landing page (site/) at the root and the app beneath it.
 */
const BASE = process.env['CAOTANG_BASE'] ?? '/';

/** The npm package a module id belongs to, or undefined for the app's own code. Windows separators are normalised first. */
function packageOf(id: string): string | undefined {
  const path = id.replaceAll('\\', '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at === -1) return undefined;
  const [first, second] = path.slice(at + '/node_modules/'.length).split('/');
  return first?.startsWith('@') === true ? `${first}/${second ?? ''}` : first;
}

const EDITOR_PACKAGES = new Set(['linkifyjs', 'orderedmap', 'rope-sequence']);
const MARKDOWN_PACKAGES = new Set([
  'unified', 'trough', 'bail', 'is-plain-obj', 'ccount', 'longest-streak', 'markdown-table', 'zwitch', 'devlop',
  'decode-named-character-reference',
]);
const MARKDOWN_PREFIXES = ['micromark', 'mdast-util-', 'remark-', 'unist-', 'vfile', 'character-entities'];

/** The vendor chunk a module goes in: React, the editor (tiptap and ProseMirror), or the Markdown pipeline. Everything else is left to the default. */
function vendorChunkOf(id: string): string | null {
  const name = packageOf(id);
  if (name === undefined) return null;
  if (name === 'react' || name === 'react-dom' || name === 'scheduler') return 'vendor-react';
  if (name.startsWith('@tiptap/') || name.startsWith('prosemirror-') || EDITOR_PACKAGES.has(name)) return 'vendor-editor';
  if (MARKDOWN_PACKAGES.has(name) || MARKDOWN_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'vendor-markdown';
  return null;
}

export default defineConfig(({ command }) => ({
  base: BASE,
  // `macroTransform` is Lingui's native transform (no Babel/SWC plugin): it compiles `msg`/`<Trans>` in the
  // app's `.tsx` and turns import of a `.po` file into that locale's compiled message catalogue. The same
  // option is set in vitest.config.ts, so the macro contract is one transform in both pipelines.
  plugins: [lingui({ macroTransform: true, failOnCompileError: true }), react(), thirdPartyNotices(), devCsp()],
  ...(command === 'serve' ? { html: { cspNonce: DEV_NONCE } } : {}),
  server: {
    // Bind the IPv4 loopback explicitly. Vite otherwise binds ::1 (IPv6) only on
    // Windows, and the e2e suite's baseURL probes http://127.0.0.1:5173 (IPv4),
    // so webServer never becomes reachable and Playwright times out at 60s.
    host: '127.0.0.1',
    // CAOTANG_E2E_PORT lets parallel checkouts each run the suite against
    // their own server instead of reusing whichever one already holds 5173.
    port: Number(process.env['CAOTANG_E2E_PORT'] ?? 5173),
    strictPort: true,
  },
  // `vite preview` serves the built app for the production smoke test (e2e/prod-smoke.spec.ts). The Playwright config sets
  // CAOTANG_E2E_PREVIEW_PORT per checkout, so two runs at once do not share a preview server.
  preview: {
    host: '127.0.0.1',
    port: Number(process.env['CAOTANG_E2E_PREVIEW_PORT'] ?? 4173),
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Vite's own warning is turned down to the highest cap on the script's allow-list: tools/check-bundle-size.mjs is the gate.
    chunkSizeWarningLimit: Math.max(...Object.values(BUDGET.allow)) / 1000,
    rolldownOptions: {
      output: {
        // Vendor chunks: a release that touches only app code leaves these hashes alone, so the browser keeps them cached, and the size
        // table names what the bytes are. They are not how the first download gets smaller (the dynamic imports are).
        codeSplitting: { groups: [{ name: vendorChunkOf, debugName: 'vendor' }] },
      },
    },
  },
}));
