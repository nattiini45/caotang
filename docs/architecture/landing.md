# Landing page — caotang.app (the spec behind `site/`)

> Status: built. #359 drew the first product pictures for the page; #366-#373 brought them to Modern's Stageshow bar.
> Cross-refs: the Modern shell the pictures show = [modern-interface.md](modern-interface.md) · the picture-by-picture rehearsal record = [site/REHEARSAL.md](../../site/REHEARSAL.md) · the deployment and its host rules = [AGENTS.md](../../AGENTS.md) § Deploy · the standing decision that the page is static = [decisions.md](../decisions.md).

`site/` is the landing page at [caotang.app](https://caotang.app/): one page of static HTML and CSS with eight product pictures (the hero and the board each in a wide and a compact layout, plus four tiles). It sells the app; it is not the app, and it holds no project, no setting and no state. This spec says how the page is built, what it may spend, what it shows, and the rule that keeps it still.

## A. The build and its gate

### A.1 Where the source lives

`site/` is the workspace package `@caotang/site` (`pnpm-workspace.yaml`). React and React DOM are its **dev** dependencies only: they render the pictures when the site is built and never reach the page. `site/package.json` carries two scripts, `build` (`node ../tools/build-site.mjs`) and `typecheck`.

| Path | What it is |
|---|---|
| `site/index.html` | the page: its copy, its `<head>` (including the CSP and the JSON-LD data block) and one `<!-- stage:name -->` marker per picture |
| `site/landing.css` | the page's own stylesheet |
| `site/stages/` | the pictures, one React component per stage, and `render.tsx` (the stage map) and `icons.tsx` (the glyph set) |
| `site/stageshow-kit/` | the vendored [Stageshow](https://benji.org/stageshow) kit (MIT), the build-time tool the pictures are drawn with; its licence ships in `notices.txt` |
| `site/assets/` | files the pictures use (the export tile's page is a real screenplay PDF page; `assets/README.md` says how it was made) |
| `site/REHEARSAL.md` | how each picture was checked against its gold, what was captured, and what is still open |
| `site/llms.txt`, `robots.txt`, `sitemap.xml`, `favicon.svg` | published as they are |

### A.2 What publishes it

`.github/workflows/pages.yml` runs on a push to `main` and by hand. It builds the app with `CAOTANG_BASE=/app/`, runs `node tools/build-site.mjs`, and copies `site/dist/` to the root of the published tree, `apps/desktop/dist` to `/app/`, and `CNAME` beside them. GitHub Pages serves that tree at the origin root. The landing page is published from `site/dist`, never from `site/` itself: the pictures exist only once the build has rendered them.

### A.3 What the build does

`node tools/build-site.mjs [--out <dir>]` writes `site/dist` (the default), and it is the only writer of that folder:

- the page's static files (`landing.css`, `llms.txt`, `robots.txt`, `sitemap.xml`, `favicon.svg`);
- the two Modern harbour wallpapers, copied from `apps/desktop/src/components/shell/modern/`, so the page and the app it opens cannot drift apart;
- the picture assets from `site/assets/`, without their notes;
- `index.html`, with each `<!-- stage:name -->` replaced by that stage's markup inside a named `[data-stage]` root;
- `stages.css` (the Caotang look, each stage's CSS, then the generated classes) and `kit/stageshow.css` (the vendored kit's CSS, under its MIT notice, kept apart so the film checks can tell the kit's rules from ours);
- `notices.txt`: the Stageshow kit's MIT licence and Lucide's ISC notice.

Each picture is a React component rendered **at build time** with `react-dom/server`'s `renderToString`, through a Vite SSR load of `site/stages/render.tsx`. Nothing in `site/stages/` runs in the browser. React's escaped attributes are unescaped, and every inline `style` the kit writes becomes a generated `.sx-…` class, because the CSP's `style-src 'self'` drops a `style=""` attribute.

The build fails, rather than shipping a broken page, when:

- `site/index.html` asks for a stage that `site/stages/render.tsx` does not render, or a rendered stage has no marker;
- a stage stylesheet is missing;
- the CSP lacks `script-src 'none'`, lacks `style-src 'self'`, or allows `unsafe-inline`;
- the page holds a `<script>` other than the JSON-LD data block;
- a `style=""` attribute, an inline event handler, or a `<style>` element is left in the page.

### A.4 Zero JavaScript

The page carries one `<meta http-equiv="Content-Security-Policy">`:

```
default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'
```

`script-src 'none'` plus the build's script check plus the size gate's zero-JS budget mean the page ships and runs no JavaScript. The JSON-LD block is data for search engines and agents, not code. The `[data-stage]` roots are static markup: nothing hydrates them, and no client entry exists to import `STAGES`.

### A.5 The size gate

`node tools/check-site-size.mjs [dir]` reads the built tree (`site/dist` by default, after `tools/build-site.mjs`) and prints every file with its raw and gzip size. It exits 1 on:

- any JavaScript at all: a `.js`, `.mjs` or `.cjs` file, a `<script>` other than the JSON-LD block, or a `modulepreload` link;
- an inline event handler in a page;
- HTML, CSS or asset bytes over their cap.

`BUDGET` in that script is the gate:

| Kind | Cap, raw | Cap, gzip | Measured at #359 (raw) |
|---|---|---|---|
| html | 112,000 B | 17,700 B | 102,288 B |
| css (landing, stages, kit) | 69,000 B | 17,400 B | 62,863 B |
| assets (pictures, wallpapers, favicon, text files) | 31,400 B | 22,300 B | 28,516 B |
| js | 0 B | 0 B | 0 B |

To raise a cap: build, run the gate, put the new size plus about 10 % in `BUDGET`, and say why in the change. The caps are the #359 build plus about 10 %, so anything larger is a decision written down where it is made. CI runs `node tools/build-site.mjs` and then `node tools/check-site-size.mjs` in the `verify` job, after the app build, on every pull request and every push.

## B. The pictures and the look

### B.1 The eight stages

| Stage | Size (px) | What it shows |
|---|---|---|
| `hero` | 1032 × 560 | the page with a selected paragraph and the agent's draft on Apply, the agent window as a satellite over the right margin (§C.1) |
| `hero-compact` | 358 × 652 | the phone hero: the page alone, cropped to the paragraph and its draft (§C.2) |
| `board` | 654 × 272 | the corkboard with one card lifted by its grip over the room the others made |
| `board-compact` | 338 × 262 | the phone board: two whole columns instead of an 18 px third |
| `local` | 333 × 200 | the Local-first tile: Settings › Providers' sealed key field hung from the tile's top-right corner |
| `binder` | 333 × 270 | Modern's binder tree, one chapter's goal ring met, cropped off the left and the foot |
| `export` | 333 × 278 | a loose stack of pages whose top sheet is a real screenplay PDF page from Caotang's own renderer |
| `findings` | 333 × 280 | the Codex & Findings tile: a mention in prose and one coherence finding on the passage it is about |

Every picture is a **still**: a poster frame of a moment in the app, not an interaction. Its words are the app's own where a label is real (a scene title, a finding, a button), and filler elsewhere; the stage's file names which are which. Cursor positions and connector ends are fixed in the stage's CSS from the built layout, because the page runs no script to measure them.

### B.2 The look

`site/stages/look-caotang.css` maps Caotang's Modern tokens onto the kit's, for every stage on the page. The two stylesheets ship apart: `kit/stageshow.css` carries the vendored kit's CSS in the kit's own layers, and `stages.css` carries the Caotang look, then each stage's own CSS, then the generated style classes. The look is unlayered, so it outranks the kit's layered rules, and a kit part a stage restyles shows up as one deliberate override rather than a second design system. The pictures use Modern's own ground, ink, type, radius and materials.

### B.3 The icons

The stages draw **one set of glyphs at one stroke**: Caotang's own Modern glyphs, copied from `apps/desktop/src/components/shell/modern/icons.tsx` (a 24 grid, stroke 1.8, round caps), and, for the glyphs the app does not draw (chevrons, a grip, a key, a lock, a pin), path data from Lucide 0.468 under its ISC licence. The set lives once in `site/stages/icons.tsx`, and a stage names a glyph rather than drawing its own. The Lucide notice ships in `notices.txt`. A new glyph joins that one file or is not used; a picture does not carry a private icon.

## C. The hero and the compact layouts

### C.1 The hero

The hero is the page's poster beat, in the wide column. A writer selected a paragraph in Modern, asked the agent to tighten it, and the draft now waits under the text with **Apply**: the product's promise is that the agent asks first, and the settled draft waiting on Apply says it in one frame, with nothing mid-change.

The composition: the page is the hero, inset from both sides and running off the stage's foot into the page below; the agent window is a satellite over the page's right margin, whole and never over the words; the ghost capsule sits inside the page above the bottom ornament. The platform is the page's own ground, never a plate, and the page never shows a better UI than the product.

**Known drift, recorded rather than scheduled.** The still draws **Retry** and **Discard** as buttons beside Apply, and a glass capsule with a word count (`Draft · 51 words`). The app since #373 shows **Apply** with Retry and Discard under a **More** disclosure, on one raised surface (`editor-modern.css`, the ghost bar). The re-film is excluded by the owner's decision that the landing stays static (D2, §D), so the picture keeps the older bar; `site/REHEARSAL.md` records it, and the landing ship files it as a deferred issue.

### C.2 The compact layouts

The compact pictures are redesigns for a phone, not the wide ones shrunk, and each is a separate stage:

- **`hero-compact`** (358 × 652) is the page alone, cropped to the paragraph and its draft, with the compact title capsule above and the capsule whole. It has no satellite, because on a phone the agent is a full-screen sheet.
- **`board-compact`** (338 × 262) shows two whole columns and the page off the right, where the wide board shows a fourth column cut at 70 px.

The tile pictures (`local`, `binder`, `export`, `findings`) are one column wide at 333 px and are the same stage at any width; the page places them in its one-column and its multi-column layouts.

## D. Static by decision (D2)

The landing page is static **by the owner's decision**, not by an unfinished step:

- no JavaScript, now or later (`script-src 'none'`, §A.4);
- no film, no motion, no animation, and no hero re-film;
- the stills are the final pictures.

Why: Stageshow is the product's design language and the pictures' build-time tool, not a runtime for the page. A motion island was once considered (a self-hosted script of about 100 kB); the owner withdrew it, and nothing in `site/` now waits for or promises one. The app's own Modern transitions are unaffected: they live in the app at `/app/`, not on the landing page.

Giving the page a script, a film or motion is therefore a new owner decision. It changes the CSP, `tools/build-site.mjs`, `tools/check-site-size.mjs` (whose JS budget is 0 bytes), this spec and `docs/decisions.md` together, in the change that does it. Until then, the gate fails any JavaScript the page gains.
