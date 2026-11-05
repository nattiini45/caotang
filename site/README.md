# caotang.app, the landing page

Static HTML and CSS. No script runs on the page: its Content-Security-Policy keeps `script-src 'none'` and `style-src 'self'`.
That is the owner's decision rather than an unfinished step: there is no script, no film and no motion on the landing, and the stills
are the final pictures ([docs/architecture/landing.md](../docs/architecture/landing.md), `docs/decisions.md`).

- `index.html`, `landing.css`, `llms.txt`, `robots.txt`, `sitemap.xml`, `favicon.svg`: the page, published as they are.
- `stages/`: the product pictures, each a Stageshow stage (React) built with the vendored kit in `stageshow-kit/`. They are rendered to
  static markup **at build time** and put where `index.html` has a `<!-- stage:name -->` marker. `stages/look-caotang.css` maps
  Caotang's Modern tokens onto the kit's. `REHEARSAL.md` says how each picture was checked and what is still open.
- `assets/`: files the pictures use (the export page is a real screenplay PDF page; `assets/README.md` says how it was made).

Build and check:

```sh
node tools/build-site.mjs        # writes site/dist: index.html with the stages in, stages.css, kit/stageshow.css, the wallpapers
node tools/check-site-size.mjs   # the HTML, CSS and asset caps, and no JavaScript
pnpm --filter @caotang/site typecheck
```

The build turns every inline `style` the kit writes into a generated class (the CSP drops `style=""`) and fails if a script, an inline
style or an event handler is left in the page. `.github/workflows/pages.yml` publishes `site/dist` at caotang.app/ and the app at
`/app/`; CI runs the same build and the size check. React is a dev dependency of this package only: it never reaches the page.
