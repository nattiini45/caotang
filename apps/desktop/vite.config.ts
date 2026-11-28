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
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: generateNotices({ root: REPO_ROOT, filters: ['./apps/desktop'] }) });
    },
  };
}

/**
 * Gives a lazy chunk a URL the runtime can import again with a fresh query. A browser caches a failed module URL
 * for the life of the page, so repeating the same import after a network failure never requests again.
 * The module is also emitted as an entry, so Rolldown shares one chunk between this URL and the ordinary dynamic import.
 */
function retryChunkUrl(urlPath: string, sourcePath: string, exportName: string, name: string): Plugin {
  const urlModule = fileURLToPath(new URL(urlPath, import.meta.url)).replaceAll('\\', '/');
  const source = fileURLToPath(new URL(sourcePath, import.meta.url));
  return {
    name: `caotang-retry-chunk-url-${name}`,
    apply: 'build',
    async transform(_code, id) {
      if (id.replaceAll('\\', '/') !== urlModule) return null;
      const resolved = await this.resolve(source);
      if (resolved === null) throw new Error(`The retryable module ${source} did not resolve.`);
      const ref = this.emitFile({ type: 'chunk', id: resolved.id, name });
      return { code: `export const ${exportName} = import.meta.ROLLUP_FILE_URL_${ref};\n`, map: null };
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
        return html.replace('<meta property="csp-nonce" />', '').replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/, (_match, open: string, policy: string, close: string) => {
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

/** The source of the workspace packages whose modules have no effect on import (matched on the resolved path, either separator). */
const PURE_PACKAGE_SOURCE = /[\\/]packages[\\/](harness|gateway|mcp-client|context|exporter|coherence|bus|store|codex|dialogue|storyboard|skills|pictures|comic|timeline|video-prompt-pack|pdf-fonts|screenplay|ids|retrieval)[\\/]src[\\/]/;

const EDITOR_PACKAGES = new Set(['linkifyjs', 'orderedmap', 'rope-sequence']);
const MARKDOWN_PACKAGES = new Set([
  'unified', 'trough', 'bail', 'is-plain-obj', 'ccount', 'longest-streak', 'markdown-table', 'zwitch', 'devlop',
  'decode-named-character-reference', 'parse5', 'entities', 'property-information', 'hastscript', 'web-namespaces',
  'trim-lines', 'fastest-levenshtein',
]);
const MARKDOWN_PREFIXES = ['micromark', 'mdast-util-', 'remark-', 'unist-', 'vfile', 'character-entities', 'hast-util-', 'comma-separated-tokens', 'space-separated-tokens'];

/**
 * The vendor chunk a module goes in: React, the editor (tiptap and ProseMirror), the Markdown pipeline, or the project store. Everything
 * else is left to the default.
 */
function vendorChunkOf(id: string): string | null {
  const path = id.replaceAll('\\', '/');
  // Keep the source catalogue in its own cacheable chunk instead of hiding it inside a shared app chunk.
  if (path.endsWith('/src/i18n/locales/en/messages.po')) return 'locale-en';
  // The store is read by every view that loads first and shared with the chunks that load on use (the exported project, the hosted
  // open). Left to the default splitting it is carved into a chunk per module, because a lazy chunk that needs one reader and the entry
  // that needs the rest no longer share a boundary: the chunks it splits into cost the first load 2.6 kB gzip more than the hosted path
  // itself weighs. One chunk keeps its hash stable across releases too, which is what a store this size is worth caching on.
  if (/[\\/]packages[\\/]store[\\/]src[\\/]/.test(path)) return 'vendor-store';
  const name = packageOf(id);
  if (name === undefined) return null;
  if (name === 'react' || name === 'react-dom' || name === 'scheduler') return 'vendor-react';
  if (name === '@lingui/core' || name === '@lingui/react' || name === 'use-sync-external-store') return 'vendor-react';
  if (name.startsWith('@tiptap/') || name.startsWith('prosemirror-') || EDITOR_PACKAGES.has(name)) return 'vendor-editor';
  if (MARKDOWN_PACKAGES.has(name) || MARKDOWN_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'vendor-markdown';
  return null;
}


/** The worker entries stay out of the application startup layer: a module Worker must never execute the shell to reach one shared helper. */
function workerEntryChunkOf(id: string): string | null {
  const path = id.replaceAll('\\', '/');
  if (path.endsWith('/apps/desktop/src/app/text-search.worker.ts')) return 'text-search-worker-entry';
  if (path.endsWith('/apps/desktop/src/import-preview/reader.worker.ts')) return 'reader-worker-entry';
  if (path.endsWith('/apps/desktop/src/workers/harness-worker.ts')) return 'harness-worker-entry';
  return null;
}
/** The DOM-free roots a worker enters through. Their dependency closures can be shared with the page without executing application code. */
function workerSharedChunkOf(id: string): string | null {
  const path = id.replaceAll('\\', '/');
  if (path.endsWith('/packages/harness/src/tools/text-search.ts')) return 'worker-text-search';
  if (path.endsWith('/packages/harness/src/worker.ts') || path.endsWith('/packages/harness/src/agent/context.ts') || path.endsWith('/packages/harness/src/scan-worker.ts')) return 'worker-harness';
  // `xml.ts` keeps the shared XML reader's own lazy chunk (#268); the archive and text readers are the pieces the Worker shares.
  if (/[\\/]packages[\\/]import-core[\\/]src[\\/]/.test(path) || /[\\/]packages[\\/]import-read[\\/]src[\\/](?:index|text|zip)\.ts$/.test(path)) return 'worker-import';
  if (path.endsWith('/apps/desktop/src/import-preview/reader-protocol.ts')) return 'worker-reader-protocol';
  if (path.endsWith('/apps/desktop/src/import-preview/reader-session.ts')) return 'worker-reader-session';
  return null;
}

export default defineConfig(({ command, mode }) => ({
  base: mode === 'native-account' ? '/' : BASE,
  // `macroTransform` is Lingui's native transform (no Babel/SWC plugin): it compiles `msg`/`<Trans>` in the
  // app's `.tsx` and turns import of a `.po` file into that locale's compiled message catalogue. The same
  // option is set in vitest.config.ts, so the macro contract is one transform in both pipelines.
  plugins: [
    lingui({ macroTransform: true, failOnCompileError: true }), react(), thirdPartyNotices(),
    retryChunkUrl('src/i18n/de-catalogue-url.ts', 'src/i18n/locales/de/messages.po', 'deCatalogueUrl', 'messages'),
    retryChunkUrl('src/app/run-recovery-url.ts', 'src/app/run-recovery.ts', 'runRecoveryUrl', 'run-recovery'),
    retryChunkUrl('src/workers/harness-worker-url.ts', 'src/workers/harness-worker.ts', 'harnessWorkerUrl', 'harness-worker'),
    retryChunkUrl('src/app/text-search-worker-url.ts', 'src/app/text-search.worker.ts', 'textSearchWorkerUrl', 'text-search.worker'),
    retryChunkUrl('src/import-preview/reader-worker-url.ts', 'src/import-preview/reader.worker.ts', 'readerWorkerUrl', 'reader.worker'),
    devCsp(),
  ],
  ...(command === 'serve' ? { html: { cspNonce: DEV_NONCE } } : {}),
  optimizeDeps: { include: ['@ui-sdk/react/agent'] },
  // The import preview's reader Worker (import-preview/reader.worker.ts) is a same-origin module Worker (`worker-src 'self'`, no
  // `blob:`) and imports each reader on first use, so it needs ES format: 'iife' cannot code-split a worker's dynamic imports.
  worker: {
    format: 'es',
    rolldownOptions: { treeshake: { moduleSideEffects: [{ test: PURE_PACKAGE_SOURCE, sideEffects: false }] } },
  },
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
    outDir: mode === 'native-account' ? 'dist-account' : 'dist',
    // Modern's wallpaper is a hashed same-origin file, never a data: URL inlined into the stylesheet (modern-interface.md §5.3, §12):
    // it stays out of Modern's CSS budget and is cached on its own. Every other asset keeps Vite's default.
    assetsInlineLimit: (file: string) => (/[\\/]shell[\\/]modern[\\/]wallpaper-[a-z]+\.svg$/.test(file) ? false : undefined),
    sourcemap: mode !== 'native-account',
    // Vite's own warning is turned down to the highest cap on the script's allow-list: tools/check-bundle-size.mjs is the gate.
    chunkSizeWarningLimit: Math.max(...Object.values(BUDGET.allow)) / 1000,
    // Modern's narrow panels (#312) are a chunk of their own (with their stylesheet) that only `modern-shell` imports, and every other
    // module they need is already loaded by then: preloading that list again would only write it into `modern-shell` and spend Modern's
    // first-load budget.
    modulePreload: {
      resolveDependencies: (filename, deps, { hostId }) => {
        // Workers cannot use Vite's DOM-based module preloader: it inserts link elements through document.
        if (/(^|\/)[\w.-]*worker[\w.-]*\.js$/.test(hostId)) return [];
        return /(^|\/)narrow-panels-[\w-]+\.js$/.test(filename) && /(^|\/)modern-shell-[\w-]+\.js$/.test(hostId)
          ? deps.filter((dep) => dep === filename || /(^|\/)narrow-panels-[\w-]+\.css$/.test(dep))
          : deps;
      },
    },
    rolldownOptions: {
      ...(mode === 'native-account' ? { input: ['account/index.html', 'account/studio.html'] } : {}),
      // The workspace packages are libraries of declarations: nothing in their src/ runs on import. Without this, one constant imported
      // from a package's barrel keeps every module that barrel re-exports in the importing chunk, and the lazy-loaded agent and exporter
      // come in with the first page (see lazy-harness.ts and lazy-exporter.ts).
      treeshake: { moduleSideEffects: [{ test: PURE_PACKAGE_SOURCE, sideEffects: false }] },
      output: {
        // Vendor chunks: a release that touches only app code leaves these hashes alone, so the browser keeps them cached, and the size
        // table names what the bytes are. They are not how the first download gets smaller (the dynamic imports are).
        // Small startup modules shared with lazy chunks otherwise become dozens of files; the first-load gate sums a gzip stream per
        // file, so that fragmentation costs tens of kilobytes without adding code. Keep them in two layered startup chunks: packages
        // do not import the app, so package-shared cannot depend back on app-shared. `$initial` keeps lazy-only readers and dialogs out,
        // the module cap keeps the capture to small shared modules, and recursive dependencies keep a captured module with what it needs.
        // Worker entries and the DOM-free roots they enter through stay ahead of those layers: sharing code with the page must not
        // make a Worker evaluate the application shell, the editor pipeline or the DOM preloader.
        codeSplitting: {
          groups: [
            { name: vendorChunkOf, debugName: 'vendor', priority: 20 },
            { name: workerEntryChunkOf, debugName: 'worker-entries', priority: 30, includeDependenciesRecursively: false },
            {
              name: workerSharedChunkOf,
              debugName: 'worker-shared',
              priority: 15,
              includeDependenciesRecursively: true,
            },
            {
              name: 'package-shared',
              tags: ['$initial'],
              test: /[\\/]packages[\\/][^\\/]+[\\/]src[\\/]/,
              maxModuleSize: 5_000,
              includeDependenciesRecursively: true,
            },
            {
              name: 'app-shared',
              tags: ['$initial'],
              test: /[\\/]apps[\\/]desktop[\\/]src[\\/]/,
              maxModuleSize: 5_000,
              includeDependenciesRecursively: true,
            },
          ],
        },
      },
    },
  },
}));
