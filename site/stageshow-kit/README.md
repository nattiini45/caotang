# Stageshow kit (vendored, trimmed)

The landing page's product pictures are built with the React kit from Benji Taylor's Stageshow (MIT, see `LICENSE`;
<https://benji.org/stageshow>). It runs **only at build time**: `tools/build-site.mjs` renders each stage in `site/stages/` to static
HTML and CSS with `react-dom/server`, so caotang.app ships no script and keeps `script-src 'none'` (#359).

Copied from the kit unchanged except for this trim: the stage and its helpers (`stage`, `act`, `cursor`, `cursors`, `keys`, `looks`,
`measure`, `reduced-motion`, `clock`, `util`, `ease`), `window` (for `Bar` and `Text`), and the parts the stills use (`parts/Row`,
`parts/Avatar`, `parts/Meter`, `parts/Check`, `controls/Badge`, `motion/Connector`). Left out: `index.ts` (it pulls every part's CSS), `kit/brands/` and
`assets/app-icons.ts` (other licences, and the page needs no logo), `parts/Icon` (it needs lucide-react), and the parts no still uses.
Import parts by their module path, never through an index.

Do not edit these files; restyle in `site/stages/look-caotang.css`. To update, copy the same files from a newer kit and rebuild.
