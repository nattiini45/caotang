---
name: Caotang
description: Glass 2 · Spatial, with Classic kept selectable
---

# Design System: Caotang

## Overview

The incumbent Modern world is **Glass 2 · Spatial**: one solid page on a wallpaper, glass ornaments, a binder tab bar that grows into a sidebar, Scene info and a companion agent window. **The glass materials are deliberate product design, not incidental decoration. Impeccable's default warning against “glass as decoration” does not apply to this chosen world.** Preserve it rather than substituting a generic dashboard.

This is a map for design work, not a second token registry. [modern-interface.md](docs/architecture/modern-interface.md) (especially §5) and [modern-controls.md](docs/architecture/modern-controls.md) are the sources of truth for their contracts; [modern.css](apps/desktop/src/tokens/modern.css) and [classic.css](apps/desktop/src/tokens/classic.css) hold the actual token values. If this summary drifts, follow the matching spec and reconcile the summary. Do not use the concept's starting values where §5.3 records settled M4 values.

Classic is a separate selectable shell, not a half-modernized fallback. Its familiar toolbar, binder rail, centre and inspector stay intact. Modern changes arrangement and materials without forking feature components. See [modern-interface.md §§2, 4, 5.4](docs/architecture/modern-interface.md).

## Colors

Modern has one accent, with light and dark values in `--accent`; paper, ink, muted text, lines, focus and state colors use semantic tokens. Material primitives (`--m-*`) vary by scheme; material tokens (`--mat-*`) name them and the accessibility fallbacks override those aliases. Use the settled values in [modern.css](apps/desktop/src/tokens/modern.css), not approximations sampled from a screenshot.

Text and icons never rely on thin glass alone: use thick glass or the scrim. Glow is decorative and does not count toward contrast. [modern-interface.md §9.3](docs/architecture/modern-interface.md) defines the computed contrast gate over wallpaper extremes. Classic's light and dark colors remain those in [classic.css](apps/desktop/src/tokens/classic.css); do not recolor Classic to Modern's accent.

## Typography

Both shells use the existing `--ui` system sans stack and `--manuscript` serif stack. The type scale and line heights live in [classic.css](apps/desktop/src/tokens/classic.css); [modern-controls.md](docs/architecture/modern-controls.md) specifies Modern control text. Modern establishes hierarchy by type, not boxes, and has no hairline grids (§5.5). Do not introduce a display face or a remote font to make the app look “designed”. Bundled export fonts are not app UI web fonts.

## Layout

Modern's stage holds the wallpaper and a floating paper page. Ornaments sit at the page's edges; the sidebar and companion take space beside it. Density is explicit: Modern uses 44 px control and row tokens, while Classic has padding-sized controls and denser binder rows. The space scale is shared, not a new utility framework. See [modern-interface.md §§5.1, 6, 9.5](docs/architecture/modern-interface.md).

At widths below 960 CSS px, use the narrow shell's compact top bar, bottom tabs, binder drawer and Scene info sheet, safe areas and desktop-only messages. Do not squeeze the desktop geometry into a phone. [modern-interface.md §13](docs/architecture/modern-interface.md) and the current narrow styles govern this behavior; keep German expansion, RTL logical properties and text scaling in the verification matrix.

## Elevation & Depth

The four materials have different jobs. **Paper** is opaque manuscript, board cards and codex detail; it is never glass. **Glass** is for ornaments, the binder bar and view lens. **Thick glass** carries text-heavy popovers, menus, palette, companion window, sheets, dialogs and toasts. **Frost** backs the board's paper cards. The glass recipe combines a translucent fill, blur and saturation, inner edge highlights, a masked gradient rim and lift; it is not a transparent fill alone. Use [modern-interface.md §5.3](docs/architecture/modern-interface.md) and the existing material classes in [shell-modern.css](apps/desktop/src/components/shell/modern/shell-modern.css), rather than copying recipes here.

The wallpaper is one built-in dawn/night harbour pair: hashed same-origin SVG assets, fixed, decorative and never animated. Text contrast must survive all its colors. Reduced transparency (system or app switch) and unsupported backdrop filtering replace glass with opaque materials. More contrast makes thick glass and scrims opaque while decorative thin glass remains translucent, with text on a scrim. Forced colors uses system-color surfaces and removes wallpaper and shadows. See [modern.css](apps/desktop/src/tokens/modern.css) and [modern-interface.md §§5.3, 9.4](docs/architecture/modern-interface.md).

Never blur the manuscript page or a surface that scrolls with its text. Keep at most four blurred layers visible. Motion uses the duration and easing tokens for hover/press, close, open and morph, with transform and opacity only except the specified page-width morph when nobody is typing. Reduced motion removes movement, retaining at most the in-place appearance fade. The pointer-following highlight is off under reduced motion and reduced transparency. Exact recipes and exceptions: [modern-interface.md §§5.3, 5.5, 8.3](docs/architecture/modern-interface.md).

Classic uses its own solid surfaces and elevation tokens, not Glass 2 materials; its default dark base shadow is absent. Its narrow drawer/sheet motion and reduced-motion behavior remain in [classic.css](apps/desktop/src/tokens/classic.css).

## Shapes

Modern uses concentric radii: an inner radius is the outer radius minus padding. Page, ornament, control, sheet and inner radii have separate tokens; do not round everything to one capsule. The exact relationships are in [modern-interface.md §5.5](docs/architecture/modern-interface.md). Classic's original radii and one-off values stay unchanged instead of being rounded to Modern's scale (§5.4).

## Components

[modern-controls.md](docs/architecture/modern-controls.md) is the common kit for buttons, fields, selects, checks, radios, switches, segmented controls, disclosures, badges, help and empty states. Apply it to shared feature markup; do not build a rival component library. Primary, secondary, ghost, destructive, disabled, hover and focus treatments belong to that contract.

Shell-specific arrangements live in [components/shell/modern/](apps/desktop/src/components/shell/modern/); [modern-interface.md §§6–8](docs/architecture/modern-interface.md) maps every feature to its home and governs navigation, dialogs, focus and notices. Modern CSS is lazy and scoped beneath `:root[data-shell='modern']`; skin files apply to Classic only. Keep a writer's work reachable in both shells.

The app's own inline SVG set is [icons.tsx](apps/desktop/src/components/shell/modern/icons.tsx), not an icon font or a runtime icon package. Individual Lucide paths may be copied and adapted under ISC with the required copyright and license notice; the landing page already has [LICENSE-LUCIDE](site/stages/LICENSE-LUCIDE). Preserve the app set's grid and stroke conventions.

## Do's and Don'ts

- **Do** preserve Glass 2, Classic and their distinct density. Follow the specs above instead of the skill's generic taste defaults.
- **Do** verify both schemes, reduced motion/transparency, keyboard focus, German expansion and narrow/RTL behavior; compute glass contrast instead of trusting axe alone.
- **Don't** add Tailwind, a motion or animation library, Lottie or LottieFiles assets, or generic stock illustrations. The existing plain CSS, material and motion tokens are the implementation path.
- **Don't** load app web fonts, scripts, styles, images or other presentation assets from a CDN or remote host. App CSP permits same-origin presentation assets (plus its explicit data/blob allowances); `connect-src` is for configured provider and MCP traffic, not a design-asset loophole. Bundled export fonts stay a separate concern. See [modern-interface.md §11](docs/architecture/modern-interface.md) and [README.md § Self-hosting](README.md#self-hosting).
- **Don't** adopt Magic UI, React Bits, 21st.dev, Uiverse, bg.ibelick, LottieFiles or unDraw. See the [recorded resource decision](docs/decisions.md) for the constraints behind the rejection.
- **Don't** add brand logos without a review of that brand's usage terms. Names in text do not require importing a third-party mark.
- **Don't** carry app effects onto the landing page: [landing.md §D (D2)](docs/architecture/landing.md#d-static-by-decision-d2) requires static HTML/CSS, still pictures, no JavaScript and no motion.
