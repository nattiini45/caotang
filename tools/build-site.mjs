#!/usr/bin/env node
// Builds caotang.app, the landing page, into site/dist (or --out <dir>): the static files of site/ as they are, plus the product
// pictures. Each picture is a Stageshow stage (site/stages/, built with the vendored kit in site/stageshow-kit/) rendered here, at
// build time, with react-dom/server. The page that ships is plain HTML and CSS: no script runs on it, and its CSP keeps
// `script-src 'none'` and `style-src 'self'` (#359).
//
// `style-src 'self'` also forbids style="" attributes, and the kit sets sizes and colours inline. So every inline style in the rendered
// stages becomes a generated class in stages.css, one per distinct declaration list, and the build fails if a style attribute, an event
// handler or a script other than the JSON-LD data block is left in the page.
//
//   node tools/build-site.mjs [--out site/dist]
//
// .github/workflows/pages.yml runs this and publishes the output at caotang.app/; tools/check-site-size.mjs holds its budget.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const out = resolve(root, outArg >= 0 && args[outArg + 1] ? args[outArg + 1] : 'site/dist');

/** The files of site/ published as they are. */
const STATIC = ['landing.css', 'llms.txt', 'robots.txt', 'sitemap.xml', 'favicon.svg'];
/** Files taken from the app so the page and the product it opens never drift apart: Modern's harbour wallpapers. */
const FROM_APP = {
  'wallpaper-light.svg': 'apps/desktop/src/components/shell/modern/wallpaper-light.svg',
  'wallpaper-dark.svg': 'apps/desktop/src/components/shell/modern/wallpaper-dark.svg',
};

function fail(message) {
  console.error(`build-site: ${message}`);
  process.exit(1);
}

/** The text of an attribute value as React wrote it, unescaped. */
const unescape = (value) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Moves every style="" of the rendered markup into a class. React escapes `"`, `'`, `<`, `>` and `&` in attribute values, so a tag
 * never holds a raw `>` and the tag pattern below is exact for this markup.
 */
function extractStyles(html, rules) {
  return html.replace(/<([a-zA-Z][\w:-]*)((?:\s[^>]*?)?)(\/?)>/g, (tag, name, attrs, selfClose) => {
    const style = attrs.match(/\sstyle="([^"]*)"/);
    if (!style) return tag;
    const declarations = unescape(style[1]).trim().replace(/;?\s*$/, '');
    if (declarations === '') return `<${name}${attrs.replace(style[0], '')}${selfClose}>`;
    const id = `sx-${createHash('sha1').update(declarations).digest('hex').slice(0, 7)}`;
    rules.set(id, declarations);
    let rest = attrs.replace(style[0], '');
    const cls = rest.match(/\sclass="([^"]*)"/);
    rest = cls ? rest.replace(cls[0], ` class="${cls[1]} ${id}"`) : `${rest} class="${id}"`;
    return `<${name}${rest}${selfClose}>`;
  });
}

/** Comments out, whitespace collapsed; a `/*!` notice is kept word for word. The CSS here holds no strings with comment markers. */
function minifyCss(css) {
  const notices = [];
  const kept = css.replace(/\/\*![\s\S]*?\*\//g, (notice) => `@notice${notices.push(notice) - 1};`);
  return kept
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/@notice(\d+);/g, (_, i) => `${notices[Number(i)]}\n`)
    .trim();
}

async function renderStages() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: site,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    oxc: { jsx: { runtime: 'automatic' } },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const mod = await server.ssrLoadModule('/stages/render.tsx');
    return { stages: mod.renderAll(), cssFiles: mod.CSS_FILES };
  } finally {
    await server.close();
  }
}

const template = readFileSync(join(site, 'index.html'), 'utf8');
const { stages, cssFiles } = await renderStages();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of STATIC) cpSync(join(site, file), join(out, file));
for (const [file, from] of Object.entries(FROM_APP)) cpSync(join(root, from), join(out, file));
// The pictures' assets, without the notes on how they were made.
if (existsSync(join(site, 'assets'))) cpSync(join(site, 'assets'), join(out, 'assets'), { recursive: true, filter: (src) => !src.endsWith('.md') });

// The stages into their markers, each inline style turned into a class.
const rules = new Map();
let html = template;
const used = new Set();
html = html.replace(/<!-- stage:([a-z0-9-]+) -->/g, (_, name) => {
  const markup = stages[name];
  if (markup === undefined) fail(`site/index.html asks for a stage "${name}" that site/stages/render.tsx does not render`);
  used.add(name);
  // Each stage in its own root, named after its marker, so the page and its build keep one name per picture.
  return `<div class="stage-root" data-stage="${name}">${extractStyles(markup.replace(/\sdata-placing="[^"]*"/g, ''), rules)}</div>`;
});
for (const name of Object.keys(stages)) if (!used.has(name)) fail(`stage "${name}" is rendered but site/index.html has no <!-- stage:${name} --> marker`);

// Two stylesheets. kit/stageshow.css is the vendored kit's CSS as it is, under its MIT notice: kept apart (and under a kit/ path) so
// the Stageshow film checks can tell the kit's own rules from ours, and a kit part restyled by a stage shows up as one. stages.css is
// the Caotang look, each stage's CSS, then the generated classes.
const license = readFileSync(join(site, 'stageshow-kit/LICENSE'), 'utf8').trim();
const read = (file) => {
  const path = join(site, file);
  if (!existsSync(path)) fail(`a stage stylesheet is missing: site/${file}`);
  return readFileSync(path, 'utf8');
};
const kitFiles = cssFiles.filter((file) => file.startsWith('stageshow-kit/'));
const ownFiles = cssFiles.filter((file) => !file.startsWith('stageshow-kit/'));
mkdirSync(join(out, 'kit'), { recursive: true });
writeFileSync(
  join(out, 'kit/stageshow.css'),
  minifyCss([`/*! The Stageshow kit's CSS (site/stageshow-kit), for the product pictures rendered at build time.\n${license} */`, ...kitFiles.map(read)].join('\n')) + '\n',
);
const generated = [...rules].map(([id, declarations]) => `.${id}{${declarations}}`).join('\n');
writeFileSync(join(out, 'stages.css'), minifyCss([...ownFiles.map(read), generated].join('\n')) + '\n');

// The notices of what the page carries from others: the Stageshow kit's CSS and markup (MIT) and Lucide's glyph paths (ISC).
writeFileSync(
  join(out, 'notices.txt'),
  [
    'Third-party notices for caotang.app (the landing page). Caotang itself is MIT-licensed; the app at /app/ carries its own notices.',
    '',
    'The product pictures are built with the Stageshow kit (https://benji.org/stageshow), rendered to HTML and CSS when the site is built:',
    '',
    license,
    '',
    'Some of their icons are drawn from Lucide (https://lucide.dev) path data:',
    '',
    readFileSync(join(site, 'stages/LICENSE-LUCIDE'), 'utf8').trim(),
    '',
  ].join('\n'),
);

// The CSP's promises, checked on what ships. Tag and attribute names are case-insensitive in HTML, so every check is too.
const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? '';
if (!csp.includes("script-src 'none'")) fail("the page's CSP must keep script-src 'none'");
if (!csp.includes("style-src 'self'") || csp.includes('unsafe-inline')) fail("the page's CSP must keep style-src 'self' with no 'unsafe-inline'");
const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/type="application\/ld\+json"/i.test(m[1]));
if (scripts.length > 0) fail(`the page has ${scripts.length} script element(s); only the JSON-LD data block is allowed`);
if (/<[^>]+\sstyle="/i.test(html)) fail('a style attribute was left in the page; the CSP would drop it');
if (/<[^>]+\son[a-z]+="/i.test(html)) fail('an inline event handler is in the page');
if (/<style\b/i.test(html)) fail('a <style> element is in the page; the CSP would drop it');
writeFileSync(join(out, 'index.html'), html);

console.log(`build-site: ${relative(root, out)}/ with ${used.size} stages (${[...used].join(', ')}), ${rules.size} generated style classes, no script`);
