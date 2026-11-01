# Classic skins

A **skin** restyles the Classic interface by token values alone ([modern-interface.md](../../../../../docs/architecture/modern-interface.md) §2.1, §2.2, D9). It never changes a layout, a selector that targets a component, or what a control does. **No skin ships yet**; this folder and the hook that reads it are the place one plugs into.

## How a skin is chosen

- The choice is `caotang.skin` in the browser's local storage, read before the first paint with the interface (`app/skin.ts`, called from `app/interface.ts`). No setting offers it until the first skin ships.
- The page wears the skin as `data-skin="<name>"` on `<html>`. The attribute is absent, and the key ignored, while the key is absent or names `default`, while it names a skin that is not in this folder, and while the Modern interface is on (Modern has no skin axis).
- Every `<name>.css` here is found by the build (`import.meta.glob`) and becomes a lazily loaded chunk of its own, loaded only while that skin is chosen, so Classic's first load never carries it. The bundle budget for one skin is at most 6 kB raw (§12).

## What a skin file may hold

`test/skin-files.test.ts` checks every file here. A skin file `<name>.css` (lowercase letters, digits and hyphens; not `default`) holds only token blocks:

- Rules whose selector is `:root[data-shell='classic'][data-skin='<name>']`, its own name, optionally followed by `[data-theme='dark']`, or by `:not([data-theme='light'])` inside `@media (prefers-color-scheme: dark)`. A skin sets light once and dark twice, the system query and the chosen theme, as `tokens/classic.css` does.
- Declarations of tokens that `tokens/classic.css` defines, and nothing else: no property that is not a custom property, no new token name.
- No at-rule but `@media (prefers-color-scheme: dark)`, `@media (prefers-reduced-motion: no-preference)` and `@media (prefers-reduced-transparency: no-preference)`.
- **Reduced motion.** A motion token (`--dur-*`, `--ease-*`) is set only inside `@media (prefers-reduced-motion: no-preference)`, so a writer who asked for less motion keeps Classic's (none).
- **Reduced transparency.** A material token (`--mat-*`, `--scrim`, `--wallpaper`), or any colour that is not opaque, is set only inside `@media (prefers-reduced-transparency: no-preference)`, so a writer who asked for less transparency keeps solid surfaces. Shadows (`--shadow`, `--elev-*`) and `--focus-halo` may be translucent anywhere.

## Classic stays the contract

A skin changes no pixel of the default skin: the Classic snapshots (`e2e/visual/`) run without `data-skin`. `e2e/unit/theme-contrast.spec.ts` reads Classic's tokens only, so a skin that ships also brings its own contrast check for the colours it sets.
