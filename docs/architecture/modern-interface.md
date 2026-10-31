# Modern interface — a spatial shell beside Classic

> Status: **specified, not built.** Epic #301, milestone "Modern interface". The foundation (§16, M1, #302: the Interface setting, the `data-shell` attribute, the default rule, an empty lazily loaded Modern stylesheet, semantic-token groundwork and the Classic visual snapshots) is **being built**. Nothing else in this document exists in the current build. The decisions in §17 bind the work when it is cut.
> Scope: a second **shell** for the writing studio, called **Modern**, chosen by the owner from the concept "Glass 2 · Spatial" (2026-10-31): the manuscript as one solid floating page on a wallpaper, glass ornaments on its edges, a binder that grows out of a slim tab bar, the inspector and the status line in a scene-info popover, views that switch by morphing the page, and the agent in a companion glass window. The current interface stays, unchanged, as **Classic**, and the writer chooses in Settings › Appearance › Interface. A token layer that lets later **skins** restyle Classic (concepts A Calm, B Glass, C Focus) is designed here as a hook only.
> Cross-refs: the Classic shell, the narrow layout and Settings = [ui-modules.md](ui-modules.md) §0–§5 · the keyboard map = `apps/desktop/src/app/keymap.ts` and ui-modules §2.5/§5.6 · the agent panel = [agent-harness.md](agent-harness.md) §8 · the editor, ghost and review marks = [editor-engine.md](editor-engine.md) §8/§15 · the codex panel = [codex-panels.md](codex-panels.md) · findings = [coherence.md](coherence.md) §8 · the binder footer = [binder-filters.md](binder-filters.md), [goals-progress.md](goals-progress.md) · interface languages and right-to-left = [i18n.md](i18n.md) §3, §5, §7 · the bundle gate = `tools/check-bundle-size.mjs` · the concept = `ui-concepts/glass2-spatial/index.html` (a design reference outside the repository; this document is the contract, not the mock).

## 0. What exists today

| Area | Where | What Modern builds on, or must not break |
|---|---|---|
| The shell | `components/Workspace.tsx` (1,553 lines): a toolbar, a left rail with five tabs (Binder, Codex, Activity, Trace, Findings), the centre (Editor / Corkboard radio group, the storage banner, the editor or a media view, the agent drawer), the inspector, the status line, and every dialog | All state and handlers live in one component; the JSX is the Classic layout. Modern needs the state, not the layout. |
| The narrow layout | `app/narrow-model.ts`, `components/narrow.tsx`, `@media (max-width: 959px)` in `styles.css` | `NARROW_QUERY`, `NarrowPanel`, `togglePanel`, `DESKTOP_FEATURES` ("Open on desktop"), the drawer and sheet focus rules (ui-modules §1). |
| Duplicated actions | The wide toolbar's buttons and the narrow **More** menu (`overflowItems`) list the same eleven actions twice, with the same handlers | Modern's **⋯** menu and the palette would be a third and fourth copy. §4.2 makes one list. |
| Colour tokens | 23 colour tokens on `:root` in `styles.css`, redefined twice for dark (the system query, and `:root[data-theme='dark']`) | They are the Classic values and stay exact. |
| Everything else in CSS | `--radius: 8px` is the only shape token; `styles.css` has 53 literal `border-radius` values and 14 `rgba()` literals, `features.css` 11 radii, `media/media.css` 14, and the per-component sheets a few more; paddings, control heights and transitions are literals | Modern changes size, shape, density and motion, so those literals become tokens whose Classic values equal the literals they replace (§5.4). |
| Theme | `app/theme.ts`: `caotang.theme` in local storage, applied as `data-theme` on `<html>` before the first paint, only for an explicit choice | The interface preference follows the same pattern for the same reason (§3). |
| Settings › Appearance | `AppearanceSection` in `components/Settings.tsx`: the theme radio only | Gains **Interface** (and, for Modern, **Reduce transparency** and **Reduce motion**). |
| CSP | `index.html`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:` | No inline `<style>`, no `style` attribute in markup, no eval, no WebAssembly (§11). |
| Bundle gate | `tools/check-bundle-size.mjs` on `main`: `index` capped at 1,565,000 B raw, first load 886,000 B gzip, all JS 6,265,000 B raw; no CSS gate | Modern must not touch Classic's first load (§12). |
| Tests | Playwright e2e in Chromium (Firefox and WebKit on pull requests), `e2e/a11y-surfaces.spec.ts` (axe), `e2e/unit/theme-contrast.spec.ts` (token ratios), `e2e/mobile-shell.spec.ts` (narrow, emulated); no screenshot assertions ("no pixel assertions in v0.1", ui-modules §6) | Visual snapshots arrive with M1 (§15). Every existing spec assumes Classic and is pinned to it (§3.4). |

The owner's verdict on the current interface, and on the earlier glass concept: too much at once, too dense, not see-through. "Reframe, don't reskin": start from what a writer does moment to moment, show the writing and a handful of controls, and let everything else appear on demand.

## 1. Goals and non-goals

**Goals**

- G1. A default writing screen with the page and **at most ten** visible controls, every one at least **44 by 44 px**.
- G2. **Nothing becomes unreachable.** Every surface, control and keyboard path in Classic has a home in Modern (§7), checked by a test that walks the table (§15.3).
- G3. **One component tree.** A shell arranges, hides and wraps the feature components; it never forks their logic (§4).
- G4. **Classic stays pixel-identical**, proven by visual snapshots taken before the first token change (§5.4, §15.4).
- G5. Real see-through glass on the control layer only, with a scrim behind any text on glass, and fallbacks for reduced transparency, forced colours, reduced motion and browsers without `backdrop-filter` (§5.3, §9).
- G6. A token layer with three independent axes, shell × skin × scheme, so Classic skins slot in later with token files and no component change (§2, §5).
- G7. Classic's first load does not grow beyond the boot switch; Modern's code and styles load only when Modern is on (§12).

**Non-goals**

- No new feature. Things the concept showed that Caotang does not have (a read-only share link, a trash, notes and pictures libraries, a story timeline view, an outline view, codex portraits, relation chips, a codex hover card in the text, the agent profile switcher as a menu) are **not** part of this epic; each has, or would get, its own spec. Where the concept placed one, Modern reserves nothing and shows nothing until the feature ships.
- No skins in this epic beyond the hook (§2.2): no Calm, Glass or Focus token files.
- No change to project files, the bus, the agent, or any setting's meaning. Interface preferences are app-level view preferences and never reach a project, a bundle or an export.
- No user wallpaper, no custom accent, no resizable or movable windows.
- No change to Classic's behaviour, layout or pixels, except the one new radio group in Settings › Appearance.

## 2. Shell, skin and scheme

### 2.1 Three axes

| Axis | Values | Where it is set | What it may change |
|---|---|---|---|
| **Shell** | `classic` · `modern` | `data-shell` on `<html>` | Layout, containers, materials, density, motion, which regions are visible by default. Never what a control does. |
| **Skin** | `default` (Classic's look today); later `calm` · `glass` · `focus`, **Classic only** | `data-skin` on `<html>`, absent for `default` | Token values only: colours, radii, shadows, type, density within Classic's layout. Never a selector that targets a component. |
| **Scheme** | `light` · `dark` | `data-theme` on `<html>` (exists), absent while following the system | Token values only. |

The axes compose by attribute selectors alone. No script computes a colour, and no component reads an axis to pick a style.

### 2.2 The skin hook (designed, not built)

- A skin is one CSS file, `apps/desktop/src/tokens/skins/<name>.css`, that redefines semantic tokens (§5.1) under `:root[data-shell='classic'][data-skin='<name>']`, once for light and once for dark (both the system query and `[data-theme='dark']`, as `styles.css` does today). A guard test (M3) fails on any selector in a skin file that is not one of those `:root` forms.
- A skin loads lazily, as Modern's stylesheet does (§12), and only while chosen.
- The preference is `caotang.skin` in local storage, read before the first paint like the theme. No UI offers it until the first skin ships; until then the key is reserved and ignored.
- Modern has no skin axis in this epic. `data-skin` is ignored while `data-shell='modern'`.

## 3. The preference, the default and migration

### 3.1 Where it is kept

`caotang.interface` in local storage, `'classic'` or `'modern'`, read by a module beside `app/theme.ts` before the first render and applied as `data-shell` on `<html>`. It is not in `AppSettings`, for the reason the theme is not: the shell decides the first paint, which happens before any database is open. A storage failure is not an error; the page then uses the rule below for that visit.

### 3.2 The default rule

Decided by the owner: **new users default to Modern; existing users stay on Classic until they switch.** "Existing" means any sign of earlier use. Resolution is one pure function, `resolveInterface(facts)` (M1), in this order:

1. A stored `caotang.interface` that is `'classic'` or `'modern'` wins.
2. Any other `caotang.*` key in local storage (`caotang.theme`, `caotang.pending.<id>`, the banner dismissal, a folder-memory key) means an existing user: **Classic**.
3. Otherwise the answer waits for the runtime store and the app settings, which the app already waits for behind "Opening your projects…" (`App.tsx`). Any project in the store, or a stored app-settings record, means **Classic**; neither means **Modern**.
4. The answer of steps 2 and 3 is written to `caotang.interface` at once, so the choice never flips on a later visit or on another check.

No workspace is rendered before the answer is known, so the wrong shell never flashes. Step 3 adds no wait: the loading screen is already there for the store.

**Gate until parity (D4).** Step 3's "Modern" applies only once Modern is complete (M12 closes). Until then `resolveInterface` returns Classic at step 3, and Settings › Appearance offers Modern labelled "Preview". A new writer must never meet a shell with a hole in it. The gate is one constant in the resolver, removed by M12.

### 3.3 Switching

Settings › Appearance › **Interface**: a radio group, **Classic** and **Modern**, with one sentence under it: "Classic is the interface Caotang has had so far. Modern shows the page and a few controls, and brings the rest in when you ask for it." The switch is live, with no reload: the same component tree re-renders in the other shell, so an unsaved journal, a running agent turn, an open dialog's draft and the editor's undo history survive (§4.1). Focus stays on the radio. Modern's **⋯** menu and its palette also carry "Switch to the Classic interface"; Classic carries nothing new outside Settings (D11).

### 3.4 Tests and the default

Every existing e2e spec was written against Classic and keeps running against Classic: a shared fixture sets `caotang.interface` to `'classic'` through `addInitScript` (M1). Only Modern specs, and the first-run spec that checks the default, start without it.

## 4. One component tree

### 4.1 What a shell is

`Workspace` keeps every piece of state and every handler it has today. Its render is split into **regions**, plain values handed to a shell component:

```
Workspace (state, handlers, dialogs) ──► regions ──► ClassicShell  (today's JSX, moved, pixel-identical)
                                               └──► ModernShell   (lazy chunk, §12)
```

`regions` holds the feature elements already built (the `Binder` with its footer, `CodexPanel`, `FindingsPanel`, `ActivityPanel`, `TracePanel`, `Inspector`, `EditorPane`, `Corkboard`, the media view, `AgentPanel`, the storage banner, the status message, the save state), the shell actions (§4.2), and the view state a shell needs to arrange them (rail tab, centre view, focus mode, narrow, agent open, the open narrow panel). Both shells render the **same instances**: switching shells re-parents elements, it does not rebuild state, because the state lives above both.

`EditorPane` stays mounted while another view is shown, as it does under the corkboard today, so its undo history, caret and scroll survive a view change in either shell.

### 4.2 Shell actions

One list, `app/shell-actions.ts` (pure, M2): each action has an id, its visible words, its handler, `disabled`, an optional `KeyAction` for its shortcut label, a group (project, writing, agent, output, app) and whether it exists in the narrow layout. The Classic toolbar, Classic's narrow **More** menu, Modern's **⋯** menu and the palette's commands render from it. The eleven Classic actions are: Projects, Project details, Undo, Focus mode, Skills, Instructions, Compile…, Export bundle, Save to folder (only where the browser has a folder picker), Settings, and the theme. A test fails if any surface lists an action that is not in the list, or the list holds one no surface shows.

### 4.3 Rules

1. A **feature component never reads the shell.** A component that sits in different containers takes a container fact, never a shell name: `AgentPanel` gets `placement: 'drawer' | 'window'` (in a window it is always open and its drawer toggle is not drawn); `CodexPanel` and `Inspector` lay themselves out by container queries on their own width. A guard test fails when a file outside `components/shell/` imports the shell context or compares against `'modern'`.
2. A shell **may** rearrange regions, hide a region behind a control, and add **shell-only containers**: in Modern `Stage`, `Page`, `Ornament`, `GlassPopover`, `Sidebar`, `CompanionWindow`, `Palette`, `Toast` and the `morph` helper, all under `components/shell/modern/`.
3. A shell **never** re-implements feature logic. Modern's Board is `Corkboard`; its Codex view is `CodexPanel`; its scene info is `Inspector`; its agent is `AgentPanel`; its compile sheet is `ExportDialog`. Where Modern shows an existing control in a new place (the review's Accept and Reject near a marked change, §8.7), it calls the same handler the original control calls.
4. Identity for tests and assistive technology: a control keeps its accessible name in both shells. Modern may add icons and change layout; it does not rename **Compile…**, **Undo** or a rail tab.

## 5. Tokens and materials

### 5.1 Tiers

1. **Primitive** values: raw colours and numbers, private to a token file.
2. **Semantic** tokens: what every component's CSS uses. Shells, skins and schemes redefine these.
3. **Component** aliases: rare local names (`--card-w`), defined from semantic tokens in the component's own sheet.

The existing names (`--paper`, `--panel`, `--raised`, `--ink`, `--ink-soft`, `--muted`, `--line`, `--line-strong`, `--accent`, `--accent-ink`, `--accent-soft`, `--danger`, `--danger-soft`, `--warn`, `--focus`, `--suggest-*`, `--dot-empty`, `--shadow`, `--radius`, `--ui`, `--manuscript`, `--rail-w`, `--inspector-w`) **are** the Classic semantic colour, type and layout tokens and keep their names and values (D6). They are not renamed: 388 uses in `styles.css` and 90 in `features.css` would churn for nothing. New semantic tokens are added beside them for what has no token today:

| Group | Tokens (Classic value = today's literal) |
|---|---|
| Surfaces | `--surface-app` (= `--paper`), `--surface-page` (= `--paper`), `--surface-sunken`, plus the existing `--panel` and `--raised` |
| Status | `--warn-soft`, `--ok`, `--ok-soft` (where a literal exists today) |
| Shape | `--radius-xs`, `--radius-sm`, `--radius-md` (= 8 px, today's `--radius`), `--radius-lg`, `--radius-pill`; Modern adds `--radius-page`, `--radius-sheet`, `--radius-ornament`, `--radius-control`, `--radius-inner` |
| Space and density | `--space-1` … `--space-6`, `--control-h`, `--control-pad-x`, `--target-min`, `--row-h` |
| Elevation | `--elev-0` (none), `--elev-1` (= today's `--shadow`), `--elev-2`, `--elev-3` |
| Focus | `--focus-width` (2 px), `--focus-offset` (2 px), `--focus-halo` (none in Classic) |
| Motion | `--dur-1`, `--dur-2`, `--dur-3`, `--ease-standard`, `--ease-spring` (Classic: today's few transition values, none where there is none) |
| Type scale | `--text-xs` … `--text-xl`, `--leading-ui`, `--leading-prose` |
| Material (Modern only; Classic defines them as solid so a stray use renders sanely) | `--mat-glass-bg`, `--mat-glass-blur`, `--mat-glass-saturate`, `--mat-glass-edge-hi`, `--mat-glass-edge-lo`, `--mat-thick-bg`, `--mat-thick-blur`, `--mat-frost-bg`, `--scrim`, `--wallpaper` |

### 5.2 Files and cascade

- `tokens/classic.css` holds the Classic values, light and dark, in the entry stylesheet (it is today's `:root` blocks, moved). `styles.css`, `features.css` and the component sheets stay unlayered and keep their selectors.
- `tokens/modern.css` and `shell-modern.css` are in Modern's lazy CSS (§12). Every selector in them starts with `:root[data-shell='modern']`, which a guard test checks (M4). That prefix outranks Classic's unprefixed rules deterministically, so Modern overrides by specificity, never by load order, and Classic never sees a Modern rule even if the file is cached.
- Modern changes most of a feature's look through token values; the few component overrides (a button's capsule shape, a tree row's height) live in `shell-modern.css` under the same prefix. Classic's shell frame (`.workspace` grid, `.toolbar`, `.rail`, the inspector column, `.center-switch`, `.status-line`, the narrow drawer and sheet) needs no scoping: Modern does not render those containers, so their rules match nothing.
- Modern's styles use logical properties only (`inset-inline-start`, `margin-inline-end`), the guard of i18n.md §5.1.

### 5.3 Materials (Modern)

| Material | Used for | Recipe (starting values from the concept; M4 measures and settles them) |
|---|---|---|
| **Paper** | The manuscript page, board cards, the codex detail | Opaque `--surface-page`; never glass. `--radius-page` 36 px, `--elev-3`. |
| **Glass** | Ornaments, the binder tab bar, the view lens | Light `rgba(255,255,255,.14)`, dark `rgba(30,28,44,.18)`; `backdrop-filter: blur(9px) saturate(185%)`; an inner top highlight (`--mat-glass-edge-hi`) and bottom edge; a light-catching rim drawn as a masked gradient border. A pointer-following specular highlight is decoration, set through the CSSOM (§11), off under reduced motion and reduced transparency. |
| **Thick glass** | The scene-info popover, the **⋯** menu, the palette, the agent window, sheets and dialogs, toasts | Light `rgba(255,250,248,.40)`, dark `rgba(22,20,34,.46)`; `blur(22–24px)`. Any run of text sits on it or on a `--scrim` chip. |
| **Frost** | The board's wall behind its paper cards | `--surface-page` at about 62% with `blur(30px)`. |

**Scrims and contrast.** Text and icons never sit on thin glass alone. Labels on an ornament sit on a `--scrim` (light `rgba(255,252,250,.30)`, dark `rgba(14,12,24,.34)`) or on thick glass. The concept's text glow is decoration and is not counted toward contrast. The bar is computed, not eyeballed (§9.3).

**Wallpaper.** One built-in wallpaper, light and dark (the concept's dawn and night harbour), as a hashed SVG asset in Modern's CSS chunk (`img-src 'self'`), never inline markup and never fetched elsewhere. It is decorative (`aria-hidden`, no alt), drawn once, fixed, and never animated.

**Fallbacks** (each turns every glass material into an opaque surface with the same contrast, and hides the specular and the glow):

- `@media (prefers-reduced-transparency: reduce)`;
- the app's **Reduce transparency** switch in Settings › Appearance, applied as `data-transparency='reduced'` on `<html>` and kept in local storage (`caotang.modern.transparency`);
- `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))`;
- `@media (forced-colors: active)`: system colours, a 1 px `CanvasText` border on every container, no shadows, no wallpaper.

**Performance.** No blur on the page or anything that scrolls with the text. At most four blurred layers are visible at once (two ornaments, the tab bar, one popover or window). Animations touch `transform` and `opacity` only, except the page's own width change during a view morph (§8.3), when nobody is typing. M4's pull request records a typing-latency trace on a 2,000-word scene in Chromium against Classic and states the difference.

### 5.4 Classic stays pixel-identical

- M1 commits Classic visual snapshots (§15.4) **before** any token work.
- Every literal that becomes a token gets a token whose Classic value equals that literal. A literal that fits no scale step stays a literal or gets its own component alias: Classic is not rounded to a scale.
- Each token-migration pull request touches one area (shell frame, binder, agent panel, dialogs, media) and must leave every Classic snapshot unchanged at a zero-pixel threshold.
- The `:root` colour values do not change at all. `e2e/unit/theme-contrast.spec.ts` keeps reading them.

### 5.5 Geometry and motion (Modern values)

Concentric radii: inner radius = outer radius − padding. `--radius-ornament` 30 px with 6 px padding gives `--radius-control` 24 px; `--radius-sheet` 32 px with 12 px padding gives `--radius-inner` 20 px; `--radius-page` 36 px. One accent (`#5145d8` light, `#8f87ff` dark in the concept; M4 checks it on every surface), hierarchy by type, not boxes; no hairline grids.

Motion: `--dur-1` 120 ms (hover, press), `--dur-2` 240 ms (close), `--dur-3` 520 ms (open, morph); `--ease-spring` `cubic-bezier(.3,1.22,.42,1)`, `--ease-standard` `cubic-bezier(.32,.72,0,1)`. Under reduced motion every duration is 0, except a 120 ms opacity fade where an element appears in place.

## 6. Region map

| Region | Classic | Modern (960 px and wider) |
|---|---|---|
| Frame | A grid: toolbar, rail, centre, inspector | A **stage**: the wallpaper, and everything floating on it |
| Page | The centre column | One floating **page** of paper, centred in the space left by the sidebar and the agent window; its width follows the view (Write about 780 px, Board about 1,120 px, Codex about 1,000 px, clamped to the space) and its height the window (top about 11% of the height, at least 84 px; bottom leaving room for the bottom ornament) |
| Top ornament | — | A glass capsule centred on the page's top edge: the **title capsule** (project name, the breadcrumb of the scene, today's target ring, a dot for an open finding or a save problem), which opens **Scene info**, and **⋯**. In Board it adds the board's own view controls; in Codex it shows the codex heading |
| Bottom ornament | The centre's Editor / Corkboard radio group, and the toolbar | A glass capsule centred on the page's bottom edge: **Write**, **Board**, **Codex** (one radio group, a glass lens sliding to the current one), then **Ask** and **Search** with its shortcut |
| Binder | The rail, always shown | A slim glass **tab bar** at the inline-start edge (Manuscript, Panels, and a decorative minimap of scene status dots) that grows into a **sidebar** the page's height; **Keep open** pins it |
| Inspector | The right column, always shown | **Scene info**, a thick-glass popover from the title capsule; **Keep open** docks it as a companion panel beside the page |
| Status line, word count, save state | The editor's footer, the toolbar's save state, the status line at the bottom | Counts and the save state in Scene info and the title capsule's ring; messages in a **toast** capsule at the top centre (§8.6); a failed or conflicting save is never only in a popover (§8.6) |
| Agent | A drawer at the bottom of the centre | A **companion window** of thick glass beside the page, which moves over to make room |
| Toolbar actions | The toolbar | **⋯** (§4.2), and the palette |
| Dialogs and menus | Dialogs and context menus | The same dialogs and menus in thick glass; a dialog opened from a control morphs out of it |
| Projects screen | `Home` on the paper colour | `Home` on the wallpaper, its sections on paper |

Below 960 px see §13.

## 7. Inventory: every surface and its Modern home

Every row must stay reachable. "Same" means the same component and handlers in a Modern container. M12's reachability test encodes this table as data (`MODERN_HOMES`) and walks it.

### 7.1 Shell and toolbar

| Classic surface | Modern home |
|---|---|
| **Projects** (toolbar) | **⋯** › Projects; palette |
| Project name → **Project details** (title, author, language, ISBN, cover) | **⋯** › Project details; palette; the title capsule's project name line inside Scene info links to it |
| **Undo** (toolbar, with its label as title) | **⋯** › Undo, with the same label; Ctrl+Z as today; palette |
| **Focus** / Ctrl+Shift+F | **⋯** › Focus mode; Ctrl+Shift+F; palette (§8.8) |
| **Skills** | **⋯** › Skills; palette; the agent window's "skills are waiting" note (same) |
| **Instructions** | **⋯** › Instructions; palette |
| **Compile…** | **⋯** › Compile…; palette; the Export dialog morphs out of its opener |
| **Export bundle** | **⋯** › Export bundle; palette |
| **Save to folder** (Chromium) | **⋯** › Save to folder; palette |
| **Settings** | **⋯** › Settings; palette (each section by name) |
| Theme toggle | **⋯** › Appearance: Light / Dark, Reduce transparency, Interface; palette |
| Save state (and **Export a backup** on failure) | Scene info (state in words); on failure or conflict a persistent toast with **Export a backup**, and a dot on the title capsule (§8.6) |
| Status line (messages, inline link, **Dismiss**) | Toast capsule with the same text, link and **Dismiss** (§8.6) |
| Storage banner (**Export a backup**, **Learn why**, **Dismiss**) | A glass notice above the page with the same words and buttons |
| Stale-tab notice, folder-save questions, delete confirm, not-empty folder | Same dialogs, thick glass |
| Narrow toolbar (**Binder**, **Inspector**, **More**) | §13 |

### 7.2 The rail

| Classic surface | Modern home |
|---|---|
| **Binder** tab: tree, rename, drag and drop, row menus (new items, media items, status and label pickers, vocabulary, **Edit synopsis**, agent access, delete), **Actions for …** buttons | Sidebar › Binder (same `Binder`). **Edit synopsis** opens Scene info on the synopsis |
| Script import actions above the tree | Sidebar › Binder, above the tree (same) |
| Binder filter bar and **Ctrl+Alt+F** | Sidebar › Binder; Ctrl+Alt+F opens the sidebar and focuses the filter |
| Binder footer: saved filters, goals, sprint timer, totals, **History**, kept words of a stopped tab | Sidebar › Binder, in one disclosure **Goals and sprint** under the tree (same `BinderFooter`); the put-back of kept words is also announced as a toast, so it is not missed while the sidebar is closed |
| **Codex** tab (list, filters, entry editor, appearances, visual references) | The **Codex** view: the page morphs to the codex, list and entry side by side (same `CodexPanel`, laid out by width). A mention chip anywhere opens it on that entry |
| **Activity** tab and its export | Sidebar › Activity |
| **Trace** tab and its export | Sidebar › Trace |
| **Findings** tab (scan, model review, groups, history, knowledge, dismissal picker), with its count | Sidebar › Findings, with the count on the tab and the title capsule's dot; Scene info lists the open findings of the scene with **Show in Findings** |

The sidebar's own tabs are **Binder**, **Findings**, **Activity** and **Trace**, a tablist with Classic's keys. The tab bar's **Manuscript** button opens it on Binder, **Panels** on the last other tab used.

### 7.3 The centre

| Classic surface | Modern home |
|---|---|
| **Editor** / **Corkboard** radio | **Write** / **Board** in the bottom ornament (same radio semantics; **Codex** is the third) |
| Editor: the scene, its title, the load banner, the empty state (**New document**, **New chapter**) | The page in Write (same `EditorPane`) |
| Ghost bar (draft preview: apply, discard) | Same, as a glass capsule pinned inside the page above the bottom ornament |
| Review bar (**Previous**, **Next**, **Accept**, **Reject**, **Accept all**, **Reject all**) | Same bar, as a capsule inside the page; optionally also near the focused change (§8.7) |
| Editor footer: word count, daily target quick-set and session ring | Scene info › Progress (same `TargetQuickSet`); the ring also on the title capsule |
| Corkboard (cards, S/M/L zoom, synopsis edit, card menu, keyboard reorder) | Board view (same `Corkboard`), the zoom in the top ornament |
| Screenplay scene (Script / Source / Pages, element menu, preview, chords) | Write view (same `ScreenplayView`), its mode switch in the page header |
| Storyboard (shot board, coverage, lightbox, prompt packs, zoom) | Board view when a storyboard is selected (same `StoryboardView`) |
| Dialogue container (graph, Ink text, Ink gate) | Write view (same `DialogueView`) |
| "Open on desktop" notices | §13 |

### 7.4 The agent drawer

| Classic surface | Modern home |
|---|---|
| Header: the panel's title, **Mode** radio group, **Stop**, open and close | Companion window header: **Agent**, **Mode**, **Stop**, **Close** (the drawer toggle is not drawn) |
| Intent box, slash list, `@`, Enter / Ctrl+Enter / Esc | Window footer (same `CommandComposer` and keys) |
| Demo intents, turns, status cards, plan and plan-offer cards, task checklist, ask-backs, findings, held plan, report, turn menu (restore, rewind), turn review, **Save as macro…**, queue, notes sent during a turn, background tasks, interrupted runs, task offers, recurring tasks, skills note, command notes | Window body, in order (same components) |

### 7.5 The inspector

| Classic surface | Modern home |
|---|---|
| Title, synopsis (`#inspector-synopsis`), status and label, keywords | Scene info, first section (same ids) |
| Notes | Scene info › **Notes** disclosure |
| Export style, codex attachments and mention chips, scene declarations (POV, day, duration, after, expected present, timeline mode, threads, knowledge), dialogue container, story part, goals, dialogue meta | Scene info › **Story details** disclosure (same `InspectorSections`) |
| Empty state and its demo intents | Scene info when nothing is selected |

### 7.6 Dialogs, Settings, Home

| Classic surface | Modern home |
|---|---|
| Export (recipes, preview, proof), Project, Skills, Instructions and memory, Vocabulary, Save as macro, Encoding review, Recovery, Twee import, Ink gate, every Confirm and Choice dialog, context menus | Same components; container and menu styles from the material layer |
| Settings, all nine sections | Same; Appearance gains **Interface**, **Reduce transparency** and **Reduce motion** |
| Home: new project, the leave suggestion, projects list (open, rename, remove), bring a project in, first-run card, Settings | Same `Home` on the wallpaper (M10) |

### 7.7 Keys

Every chord in ui-modules §2.5 and §5.6 and the screenplay chords keeps its meaning in Modern (§8.9).

## 8. Interaction model

### 8.1 Ornaments

An ornament is a glass capsule that floats half over the page's edge. The top one is `role="toolbar"` named "Scene"; the bottom one is a `nav` named "Views and tools" holding the view radio group and the two buttons. Tab enters an ornament, the arrow keys move inside it (the APG toolbar and radio patterns), Tab leaves. Every control is at least 44 px (the concept's 48 to 64 px is the target), labelled with words and an icon; when the labels would not fit (a long interface language, a narrow window) a container query drops the words to icons with the words kept as the accessible name and the tooltip, never truncating a word.

### 8.2 Popovers

Scene info, **⋯** and the agent's profile line are popovers: one at a time, anchored to their opener, flipped and clamped into the viewport by script (CSSOM positions, §11; CSS anchor positioning is not yet in every engine the suite runs). Scene info is a non-modal `role="dialog"` that takes focus on its first field; **⋯** is a `role="menu"` with Classic's menu keys. A click outside, Escape, or the opener closes it, and focus returns to the opener (decisions.md, "Panels return focus to their opener"). Escape in a field first commits the field, as Classic's Escape does.

### 8.3 Morph

A popover, sheet or window grows out of the control that opened it and shrinks back into it: a FLIP animation through the Web Animations API from the opener's rectangle to the target's, `--dur-3` with `--ease-spring` to open and `--dur-2` to close, the content fading in after the first third. Focus moves when the animation starts, not when it ends, and the target is interactive at once. A view change morphs the page: its position and size transition through custom properties set by the layout function, the old view fades and scales out, the new one fades in; the editor stays mounted (§4.1). Under reduced motion nothing moves: a popover appears with a 120 ms fade and a view changes at once. The View Transitions API may replace the page morph later; nothing depends on it.

### 8.4 Layout

One pure function, `modernLayout({ viewport, view, sidebar, agent, info })` (M5), returns the page, ornament, sidebar and window rectangles, as the concept's `layout()` does, so geometry is unit-tested and the components only apply it. The page shrinks before anything overlaps it. From 1,280 px down the agent window and a docked Scene info overlap the page as sheets at the inline-end edge with a scrim, instead of pushing it.

### 8.5 The binder tab bar and sidebar

The tab bar opens into the sidebar on a hover held for 140 ms, a click, Enter or Space, or Ctrl+Alt+F. A hover-open does not move focus; a click or key moves focus to the current row. The sidebar closes 420 ms after the pointer leaves, unless it is pinned or focus is inside it; Escape closes it and returns focus to the tab bar. **Keep open** (`aria-pressed`) pins it and the page moves over; the pin is a view preference in local storage (`caotang.modern.binderPinned`). Choosing a scene in an unpinned sidebar closes it on the editor, as the narrow drawer does today. The minimap is decorative (`aria-hidden`).

### 8.6 Notices

Classic's status line becomes a toast capsule at the top centre with the same roles (`status`, or `alert` for an error), the same text and link, and the same rule: it stays until dismissed or replaced. A message with an action is never dismissed on a timer (WCAG 2.2.1). A save that failed or conflicts is a persistent toast with **Export a backup**, plus the dot on the title capsule; the stale-tab notice stays a dialog.

### 8.7 The review near the text

Optional polish inside M7: when a marked change has focus or the pointer, a small glass capsule with **Reject** and **Accept** appears beside it, calling the review bar's own handlers for the change in focus. The review bar stays the full control and the keyboard path.

### 8.8 Focus mode

Focus mode hides the ornaments, the tab bar, a docked Scene info and the agent window, as far as the Writing setting **In focus mode, hide the binder and the inspector** says. A **Leave focus mode** capsule (44 px) stays at the top, so the button that left the mode is always there (ui-modules §1); moving the pointer to an edge or tabbing into the hidden ornaments brings them back until focus leaves. Ctrl+Shift+F leaves as today.

### 8.9 The palette

**Search** and **Ctrl+K** (Cmd+K) open a modal palette of thick glass: a combobox over a grouped listbox (APG). Sources: scenes and folders by title and synopsis, matched by the binder filter's own text criterion so there is one search, not two; codex entries by name and alias, with the codex panel's collation; every shell action; the views, the sidebar tabs, Scene info, the agent; and each Settings section. Empty, it shows recent scenes and the common commands. The arrow keys move, Enter runs, Escape closes and returns focus. With no match, Enter opens the agent window with the text in the Intent box and **does not send it** (a send can spend the writer's money). The model is `app/palette-model.ts`, pure and shell-free; only Modern mounts it in this epic (D11).

### 8.10 The agent window

**Ask** and **Ctrl+J** (Cmd+J) open and close it; it morphs out of whatever opened it (Ask, a finding's **Fix with agent**, an empty state's agent request, which all go through `runAgentIntent`). The page moves over and recedes slightly (`scale(.985)`, not under reduced motion). It is an `aside` named "Agent", non-modal; it hosts `AgentPanel` with `placement="window"`. Escape inside it keeps Classic's meaning first: with the Intent box empty and a turn running, Escape stops the turn (`agent-stop`, which acts only when the turn is stoppable). Otherwise Escape closes the window and focus returns to **Ask**. A turn keeps running while the window is closed, and **Ask** shows that it is working.

### 8.11 Keyboard map

Modern adds two chords and nothing else. Both are resolved in `keymap.ts`, from a new `KeyContext.shell`, before the text-field rule, so they work while typing; both yield to an input method that is composing.

| Chord | Action | Why this chord |
|---|---|---|
| Ctrl+K (Cmd+K) | Open the palette (`palette`) | The convention for a command palette; no Caotang, editor or screenplay use; pages may take it from the browser |
| Ctrl+J (Cmd+J) | Toggle the agent window (`agent-toggle`) | Free in Caotang and the editor. Browsers show downloads on it; the M8 e2e checks in Chromium, Firefox and WebKit that the page receives it, and if one engine keeps it, Ask and the palette still reach the window (§18, Q3) |

Existing chords in Modern: Ctrl+N, Ctrl+Z, Ctrl+Enter, F2, Delete, the arrow and Alt+arrow keys, the corkboard keys and the Intent box keys are unchanged. Ctrl+Shift+F is focus mode (§8.8). Ctrl+Alt+F opens the sidebar on the filter. The screenplay's Ctrl+E, Ctrl+Shift+1–9 (Cmd+Alt+1–9) are unchanged; Ctrl+Shift+S (Cmd+Alt+S) opens the sidebar on the section and switches to Board, as Classic switches to the corkboard; Ctrl+Shift+Y (Cmd+Alt+Y) opens Scene info on the synopsis.

Escape, from the innermost: the input method; an open menu; the palette; a popover; the review capsule; the unpinned sidebar; the agent window (with the stop rule above).

Chords considered and not taken: Ctrl+B and Ctrl+I (bold and italic in the editor), Ctrl+E (the screenplay element menu; the concept had it for Compile), Ctrl+1–9 (browser tabs, not reliably available to a page), Cmd+Alt+1–9 (the screenplay chords on a Mac), Ctrl+Shift+I and Ctrl+Shift+J (developer tools), new Ctrl+Alt letters (AltGr on Windows layouts, decisions.md), F6 (browser focus cycling). Dedicated chords for Write, Board, Codex, the sidebar and Scene info wait for evidence that the palette is not enough (§18, Q4). A test runs every existing chord through `resolveKey` in both shells and fails on any change, and checks that the two new chords resolve to `null` in Classic.

## 9. Accessibility

### 9.1 Landmarks and order

One `main` (the page, named by the document's title); `nav` "Binder" (the tab bar and sidebar); the top ornament `role="toolbar"` "Scene"; `nav` "Views and tools" (the bottom ornament); `aside` "Agent"; Scene info `role="dialog"` "Scene info"; the palette a modal `dialog` "Search and commands". The DOM order is the visual reading order (top ornament, binder, page, bottom ornament, companion window) with no positive `tabindex`; a "Skip to the page" link is the first stop. The wallpaper and minimap are `aria-hidden`.

### 9.2 Focus

A two-tone ring (`--focus` outside, `--focus-halo` inside, 3 px, offset 2 px) that meets 3:1 against glass, scrim and paper in both schemes. Focus moves into a popover or window as it opens and back to its opener as it closes, unless the writer has already moved it (the narrow layout's rule). A modal (the palette, a dialog) makes the rest `inert`; popovers and the agent window do not.

### 9.3 Contrast on glass

A computed test, in the style of `theme-contrast.spec.ts`, composites each Modern text token over each surface it can sit on (the scrim and thick glass over the lightest and the darkest colour of the wallpaper in that scheme, the paper, the frost) and requires 4.5:1 for text, 3:1 for large text, icons, focus rings and control boundaries (WCAG 1.4.3, 1.4.11). axe cannot see through `backdrop-filter`, so this test, not axe, is the contrast gate on glass; axe still scans every Modern surface for everything else. The same pairs are checked in the reduced-transparency surfaces.

### 9.4 Preferences

`prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more` (thick glass and scrims at full opacity) and `forced-colors` are honoured from the system; **Reduce motion** (`data-motion='reduced'`, `caotang.modern.motion`) and **Reduce transparency** are also switches in Settings › Appearance, because not every system exposes them. Both switches say they apply to the Modern interface.

### 9.5 Size and count

Every control in Modern, including tree rows, menu items, tabs, chips that act and toast buttons, is at least 44 by 44 px; a checkbox or radio counts with its label; a link inside a sentence keeps its line. On the default Write screen, with nothing open and no notice, at most ten controls are reachable outside the page: the title capsule, **⋯**, **Write**, **Board**, **Codex**, **Ask**, **Search**, and the tab bar's **Manuscript** and **Panels**, nine. A notice adds its own buttons while it shows. Tests measure both (§15.3).

### 9.6 Pointer and touch

Nothing is hover-only: the sidebar opens on click and key, the review capsule on focus, tooltips repeat an accessible name. Drag and drop keeps its keyboard equivalents.

### 9.7 Zoom and right-to-left

At 200% zoom a 1,440 px window is 720 CSS px wide and gets the narrow Modern layout (§13), with nothing clipped. Under a right-to-left interface the tab bar sits at the inline-start edge and the agent window at the inline-end edge by logical properties, morph directions read `--dir`, and Modern ships right-to-left as Preview under i18n.md D8.

## 10. Interface language

- Modern's words are plain English in the component source, as every Caotang string is until Lingui lands; they join the shell strings of #196 when that is cut, or a follow-up names them.
- Counts and dates go through `apps/desktop/src/i18n/locale.ts` (`formatCount` and its siblings), never `toLocaleString('en-US')` as the concept does. Writer content in labels (titles, names) goes through `<UserText>` / `isolate` once i18n.md §5.3 lands, and is plain text until then.
- Labels must survive German's 30 to 40% growth: ornaments drop words to icons by container query (§8.1), popovers and the sidebar wrap, nothing truncates mid-word.
- Shortcut labels come from `shortcutLabel` (Ctrl in labels today; layout- and platform-aware labels follow i18n.md §7.2).

## 11. Content Security Policy

The policy does not change. Modern stays inside it:

- Styles come from stylesheets in the bundle. Positions, sizes and the specular highlight's coordinates are set through the CSSOM (`element.style.setProperty`, React's `style` prop), which `style-src 'self'` does not govern; no `style` attribute is written into markup and no `<style>` element is created at run time, so no CSS-in-JS runtime.
- Motion is CSS transitions and the Web Animations API. No `eval`, no `new Function`, no WebAssembly, no worker beyond `worker-src 'self'`.
- Icons are inline SVG elements rendered by React; the wallpaper is a same-origin asset; there are no web fonts beyond the bundled ones and no remote image.
- Modern's e2e specs fail on any `securitypolicyviolation` event, as the existing CSP listener does.

## 12. Bundle budget

Numbers against `main`'s budget (`index` 1,565,000 B raw, first load 886,000 B gzip, all JS 6,265,000 B raw). Each pull request measures and records its real numbers, as the gate requires.

| Piece | Where it loads | Budget |
|---|---|---|
| The boot switch (`resolveInterface`, the attribute, the lazy import trigger) and the Appearance radio | Entry (both shells) | at most +1.5 kB raw, +0.6 kB gzip to the first load |
| Shell actions (M2) | Entry | about neutral: it replaces the duplicated lists |
| `ClassicShell` (moved JSX) | Entry | neutral |
| Modern JS (`ModernShell`, ornaments, sidebar, popovers, morph, palette, companion window, layout) | One lazy chunk, `modern-shell`, imported only when `data-shell='modern'`, started at boot beside the store's opening so it costs no extra wait behind the loading screen | target 60 kB raw / 18 kB gzip, cap 70 kB raw |
| Modern CSS (`tokens/modern.css`, `shell-modern.css`) | The same chunk's stylesheet | cap 30 kB raw / 7 kB gzip |
| Wallpaper | Asset referenced from Modern's CSS | at most 40 kB per scheme |
| A Classic skin (later) | Its own lazy stylesheet | at most 6 kB raw each |

Changes to `tools/check-bundle-size.mjs` (M4): a cap map for named lazy chunks; a check that `modern-shell` is not among `initialFilesOf(index.html)`; a CSS section (the entry stylesheet may not grow beyond its measured size plus 1%, and Modern's CSS has its cap); and a reported "Modern first load" (the first load plus Modern's chunk and CSS, gzip), which must stay within 25 kB gzip of the Classic first load. `totalJs` rises once, by the measured size of the Modern chunk, in the pull request that adds it. A `modulepreload` for the Modern chunk is not used, because it would land in Classic's first load.

## 13. Narrow and mobile

Below 960 px (`NARROW_QUERY`), Modern has its own narrow layout, with the narrow layout's rules (ui-modules §1) unchanged in substance:

- The page fills the width with a small margin and a smaller radius. The top ornament becomes a compact capsule (title, **⋯**); the bottom ornament becomes a tab bar (**Write**, **Board**, **Codex**, **Ask**, **Search**) above the bottom safe area.
- The binder is the drawer from the inline-start edge, Scene info is the bottom sheet (at most 80% of the height), and the agent window is a full-height sheet. At most one is open (`NarrowPanel` gains `'agent'`); while one is open the rest is `inert` behind a scrim; Close, a tap on the scrim, or Escape closes it, and focus returns to its button.
- What a phone leaves to a desktop says so in the same words (`DESKTOP_FEATURES`): **Board** on a prose chapter shows "Open on desktop: the corkboard"; a storyboard, a dialogue graph, screenplay Pages, MCP & tools and the other export formats likewise. Nothing is hidden silently.
- Thick glass only, and less of it; `prefers-reduced-transparency` gives solid surfaces.
- Targets 44 px, `env(safe-area-inset-*)`, `100dvh`. Tested in `e2e/mobile-shell.spec.ts`'s Chromium projects at 375 and 768 px, emulation only, as today.

## 14. Classic

Classic is the current shell and stays the contract of ui-modules.md, with three additions: Settings › Appearance › **Interface**; the shell-actions list behind its toolbar and More menu; and token names behind its literals. None changes a pixel or a behaviour outside Settings, which the snapshots prove (§15.4).

## 15. Testing

### 15.1 Unit (Vitest, and Playwright model specs in `e2e/unit/`)

`resolveInterface` over every combination of stored value, other keys, projects and settings record, and the parity gate; the shell-actions list against the Classic toolbar and More menu; `resolveKey` in both shells for every chord; `modernLayout` geometry at 960, 1,100, 1,280, 1,440 and 1,920 px with each combination of sidebar, agent and info; the palette model's grouping, matching and empty state; token parity (every semantic token defined in Classic light, both Classic dark blocks, Modern light and Modern dark; Classic colour values unchanged).

### 15.2 Guards (repo tests)

No file outside `components/shell/` reads the shell; every selector in Modern's CSS starts with `:root[data-shell='modern']`; skin files hold only `:root` token blocks; Modern CSS uses logical properties; no `toLocaleString('en-US')` in Modern code; the Modern chunk is not in the first load.

### 15.3 End to end (functional)

A spec per region (ornaments and views, the sidebar and its pin, Scene info and its docking, the agent window and its Escape rule, the palette, notices, focus mode, the dialogs, Home); the live switch keeps an unsaved journal, a running turn and the editor's undo history; the reachability walk over `MODERN_HOMES`; the default-control count (§9.5) and the 44 px measure; a keyboard-only walk through the default screen; axe on every Modern surface in both schemes; the reduced-transparency and reduced-motion switches; the CSP listener. Firefox and WebKit run the functional Modern specs in their pull-request shards.

### 15.4 Visual snapshots (CI only)

Playwright `toHaveScreenshot` in a `visual` project, run only in CI in the pinned Linux Chromium image, because fonts and anti-aliasing differ between machines; locally it runs only with `CAOTANG_VISUAL=1` in the same image. Animations are disabled (`animations: 'disabled'`, reduced motion), the caret is hidden, and time-dependent text (save times, dates) is masked. Baselines are committed under `e2e/visual/__snapshots__/` and updated only by a `workflow_dispatch` job whose PNGs are reviewed in the pull request.

- **Classic lock-in (M1):** the projects screen, the workspace with the binder, an open scene, the inspector and the agent drawer, the corkboard, the Codex, Findings and Activity tabs, Settings › Appearance, the Export dialog and the narrow layout at 390 by 844, light and dark. Threshold: zero pixels. Taken before any token work, and unchanged by every pull request of this epic except where Settings › Appearance gains its new radio (re-baselined once, in M1).
- **Modern (M4 onwards):** 1,440 by 900, light and dark, glass and reduced transparency: Write, Board, Codex, Scene info, the sidebar open and pinned, the agent window, the palette, **⋯**, a toast, focus mode; and the narrow Modern layout at 390 by 844.

## 16. Rollout

| Phase | Issue | What lands | Visible to writers |
|---|---|---|---|
| 0 | this spec | The contract | — |
| 1 | M1 #302 (being built) | The setting, `data-shell`, the default rule with the parity gate, the empty lazy Modern stylesheet, token groundwork, Classic snapshots, the Classic e2e pin | Settings › Appearance › Interface with Modern as "Preview" |
| 2 | M2 #303, M3 #304 | One shell-actions list; size, shape, density, elevation and motion tokens; the skin hook | Nothing |
| 3 | M4 #305, M5 #306 | The stage, wallpaper, page and materials with every fallback; ornaments, **⋯**, the Write / Board / Codex morph | Modern (Preview) is usable for writing |
| 4 | M6 #307, M7 #308, M8 #309, M9 #310 | The sidebar, Scene info, the agent window, the palette | Every surface reachable |
| 5 | M10 #311, M11 #312 | Dialogs, menus, Home and notices in glass; the narrow Modern layout | Modern complete on every width |
| 6 | M12 #313 | The accessibility and reachability gate; the user guide and changelog for both interfaces; the parity gate removed, so new users get Modern | New users start in Modern |

Phases 2 and 3 can overlap once M1 merges; M6 to M9 run in parallel after M5. Each issue names what blocks it.

## 17. Decisions

Recorded on 2026-10-31. **[owner]** lines are the owner's; the rest are delegated engineering calls inside them.

| # | Decision | Rejected alternative and why |
|---|---|---|
| D1 | **Modern is a second shell; Classic stays selectable** in Settings › Appearance › Interface. [owner] | Replacing the interface: long-time writers lose a layout they know, with no way back. |
| D2 | **Modern follows "Glass 2 · Spatial"**: one solid page on a wallpaper, glass ornaments, a tab bar that grows into a sidebar, Scene info for the inspector and status, view morphs, a companion agent window, ten controls or fewer, 44 px targets. [owner] | Concept B (Glass): a reskin of the same density, not see-through enough. |
| D3 | **New users default to Modern; anyone with a stored project, settings record or `caotang.*` key stays on Classic** until they switch, and the answer is stored at once. [owner] | Everyone to Modern: changes a working writer's screen without asking. A one-off prompt: a decision on the first screen a new writer sees. |
| D4 | **The new-user default waits for parity**: until M12 closes, new users get Classic and Modern is "Preview". | Default at M1: a new writer would meet a half-built shell. |
| D5 | **One component tree**; shells arrange and wrap, never fork; feature components take container facts, never the shell. | Two trees: every feature built twice and drifting apart. |
| D6 | **Existing token names are kept** as Classic's semantic tokens; new tokens are added only where a literal stands. | Renaming to a new scheme: hundreds of edits for no visible gain and a riskier pixel lock. |
| D7 | **Modern overrides by a `:root[data-shell='modern']` prefix**, in a lazily loaded stylesheet; Classic's rules stay unscoped. | Cascade layers: the unlayered Classic sheets would outrank a layered Modern sheet, and layering Classic risks its pixels. |
| D8 | **The preference lives in local storage** (`caotang.interface`), applied before the first paint, like the theme. | `AppSettings`: read after the first paint, so the wrong shell would flash. |
| D9 | **Skins are token files for Classic only**, on their own axis, loaded lazily; only the hook is built now. [owner, scope] | Skins inside this epic: a second axis to test before the first exists. |
| D10 | **Two new chords only**, Ctrl/Cmd+K and Ctrl/Cmd+J; everything else through controls and the palette. | The concept's ⌘B, ⌘I, ⌘E, ⌘1–3: bold, italic, the screenplay element menu and browser tabs. |
| D11 | **Classic gains no new surface outside Settings** in this epic (no palette, no Modern notice). | Adding the palette to Classic: changes Classic's behaviour in an epic that promises it does not change. |
| D12 | **Visual snapshots run only in CI**, in a pinned image, with zero-pixel thresholds for Classic. | Local snapshots: font and anti-aliasing differences make every machine fail. |
| D13 | **Contrast on glass is computed** from tokens over the wallpaper's extremes, because axe cannot see through `backdrop-filter`. | Trusting axe: it would report a pass it cannot measure. |
| D14 | **No new features ride along**: what the concept showed and Caotang lacks waits for its own spec. | Building them here: the epic would never close, and each needs its own design. |

## 18. Open questions

| # | Question | Default until answered |
|---|---|---|
| Q1 | Should Classic users be told once that Modern exists (a single dismissible notice), or only through Settings and the changelog? | Settings and the changelog only (D11). |
| Q2 | Is the hover-open of the binder sidebar wanted, or only click and keys? | Hover after 140 ms, as in the concept. |
| Q3 | If a browser keeps Ctrl+J for its downloads, which fallback chord? | None; Ask and the palette reach the window. |
| Q4 | Dedicated chords for Write, Board, Codex, the sidebar and Scene info? | None until the palette is shown not to be enough. |
| Q5 | Board's Outline and Timeline modes from the concept: an outline view is unspecified, and the timeline view is its own milestone. Should the top ornament reserve the switch? | No switch until a second mode exists. |
| Q6 | A second wallpaper, or the writer's own picture through the picture registry? | One built-in wallpaper per scheme. |
| Q7 | Should **Reduce motion** and **Reduce transparency** also apply to Classic (it has little of either)? | Modern only, and the help text says so. |
