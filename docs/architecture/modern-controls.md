# Modern controls: the control kit

Status: built (Stageshow polish, #357). Part of the Modern interface ([modern-interface.md](modern-interface.md) §5.2, §9.3, §9.5).

`apps/desktop/src/components/shell/modern/controls-modern.css` gives Modern one set of controls. It sits in Modern's lazy stylesheet (imported by `modern-shell.tsx` after `surfaces-modern.css`), so Classic never loads it.

The kit works **by selector**. Classic's own markup (`.button`, native fields and selects, checkboxes and radios, `.segmented`, `<details>`, `.badge`, the help lines, `.empty-state`) takes the Modern look wherever Modern renders it: Settings, the dialogs, Home, the sidebar, Scene info, Codex, Timeline, Pictures, the agent and import/export. No TSX change is needed.

New markup uses the same Classic classes, or a `k-` class where none fits.

## Rules

- **Prefix.** Every selector starts with `:root[data-shell='modern']` (test/modern-css.test.ts). Only logical properties are used. A right-to-left interface flips the chevron, the magnifier and the switch thumb through `:root[data-shell='modern'][dir='rtl']`.
- **Specificity.** The kit sits one class (or one element) above the prefix. As a result:
  - a Classic rule of one or two classes loses to it;
  - a surface's own Modern rule (`scene-info.css`, `companion.css`, `binder-sidebar.css` …) wins when it is more specific. Write a surface rule only when the kit is wrong for that surface.
- **44 px.** Every button, field, select, segment and summary is at least `--target-min`. A check, radio or switch is a 20 px mark whose **label row** is 44 px tall; the gate (e2e/modern-gate.spec.ts) counts it with its label. A check without a label is the markup's job (wrap it in a `<label>`).
- **Contrast.** All fills are opaque steps, never a translucent wash, so the ratios hold in light, dark and solid (Reduce transparency).
  - Text on every kit fill keeps at least 4.5:1.
  - A mark's edge (`--k-edge`) keeps at least 3:1 on paper, raised and panel.
  - The chevron and magnifier grey (`#878290`) keeps 3:1 in both schemes.
- **One icon set.** The chevron, magnifier and tick are the ornaments' 24-unit strokes (`icons.tsx`), drawn at 20 px as data-URI images. The app's CSP allows `img-src data:`.

## Tokens

These are set by the kit, with light values and a dark override in both dark blocks:

| Token | Use |
|---|---|
| `--k-fill`, `--k-fill-hover` | Secondary button surface |
| `--k-quiet` | Quiet button's resting surface (a lighter step; a control keeps a surface at rest) |
| `--k-track`, `--k-thumb` | Segmented track and selected segment; badge fill |
| `--k-edge` | The edges of checks, radios and the off switch (3:1); a field's hover edge |
| `--k-help-ink` | Help text. It is `--muted`. On Scene info's thick glass it is a deeper ink until that surface is opaque |
| `--k-chevron`, `--k-search`, `--k-tick` | The icon images (`--k-tick-dark` holds the dark tick) |
| `--k-pad-start`, `--k-pad-end` | A field's inline padding. Search sets the start and select sets the end, so a surface rule that sets `padding` cannot hide the icon behind the text |
| `--k-radius-field`, `--k-mark` | 12 px field radius; 20 px mark |

## Classes and what they style

| Control | Selector (existing markup) | Kit class (new markup) | Notes |
|---|---|---|---|
| Button, secondary | `.button` | — | Tonal pill, 15/500, 44 px, 16 px inline padding |
| Button, primary | `.button.is-primary` | — | Accent fill. Use **one per surface** |
| Button, quiet | `.button.is-quiet` | — | Lighter surface at rest, `--ink-soft` text |
| Button, danger | `.button.is-danger` | — | Danger text on the button's own surface. In a Confirm (`.confirm`) it stays filled, as in Classic |
| Icon button | `.button.is-icon` | `.k-icon-button` | 44 × 44 circle; its `svg` is 20 px. Give it an `aria-label` |
| Text field | `input` of type text, email, url, password, tel, date or time, untyped `input`, `.keyword-input`, `textarea` | — | 12 px radius, `--line-strong` edge, `--raised` fill, 15 px text. A code box (`.skills-editor`, `.mcp-export`, `.tl-calendar-box`) keeps monospace. The palette's query and a source field's `.src-input` (it must match its highlight layer) are left out |
| Search field | `input[type=search]` | — | Magnifier at the start |
| Number field | `input[type=number]` | — | No spinners (the arrow keys still step), tabular digits, at least 4 ch wide |
| Select | `select` (single) | — | `appearance: none`, chevron at the end; the list stays the system's. `select[multiple]` and `[size]` lose the chevron |
| Menu button that picks a value | `.picker-button` | — | Looks like a select (Scene info's Status and Label) |
| Checkbox | `input[type=checkbox]` | — | 20 px, 6 px radius, accent with a tick when checked; indeterminate shows a bar |
| Radio | `input[type=radio]` | — | 20 px circle, accent with an inner dot |
| Switch | `input[type=checkbox][role=switch]` | `input[type=checkbox].k-switch` | 36 × 22 track; the thumb moves to the end when on. In a label, it sits at the row's end |
| Check, radio or switch row | `label` whose direct child is that input (not `.export-option`, `.policy-option`) | — | A block row, 44 px tall. The mark hangs at the start and the words wrap under themselves, whatever the label holds (`<code>`, a hint `<span>`). Classic's `label > span` caption style is undone inside it, and inside an `.export-option` card, whose name is its title |
| Radio group | `.settings-radios` | — | A column of rows |
| Fieldset and legend | `fieldset`, `legend` | — | No groove border; the legend is a 13/600 group label |
| Segmented | `.segmented` + `.segmented-item`, `.tl-segmented` + `.tl-segmented-item` | `.k-segmented` + `.segmented-item` | Track with 3 px inset; segments 44 px; the selected one (`aria-checked`, `aria-pressed` or `aria-selected` = true) on `--k-thumb` |
| Disclosure | `details > summary` | — | 44 px row, 14/600, the chevron at the start pointing inline-end, turned down when open |
| Help text | `.field-help`, `.field-note`, `.settings-note`, `.project-dialog-help`, `.export-note`, `.export-option-help` | `.k-help` | 13 px in `--k-help-ink`, never the warning colour. `.field-note.is-complaint`, `.is-error` and `[role=alert]` stay `--danger` |
| Badge | `.badge` (`.is-warn`, `.is-source-mcp`) | `.k-badge` (`.is-accent`) | Tonal pill, 12/600, sentence case (no uppercase or tracking) |
| Link | `a` without a class | — | Accent, underlined, never UA blue |
| Empty state | `.empty-state` | `.k-empty` | No dashed box: centred words on the surface, 32 px block padding, 15/600 title |

Focus is the two-tone ring (`--focus` outside, `--focus-halo` inside) on every kit control. Forced colours draws `ButtonText` edges, removes the images, and gives checks and radios their system look.

## Surface layouts the kit settles

- The agent's Mode (`.agent-mode`) is a grid: "Mode", then the four options in two even columns, so none wraps alone in the 400 px window. Its segmented control is #363's.
- The binder's saved-filter menu (`.filter-row select`) keeps its whole name; Save wraps to the next line when both don't fit.

## Shared fixes (Classic too)

These live in `styles.css`, because they were Classic bugs that Modern inherited:

- `.button` has a 1.35 line height with 5 px block padding. The box stays about 29.6 px, but the line now holds the font: it needed 31 px and was cut.
- `.project-meta .project-name` has no margin. The toolbar title's start margin had moved Home's project names 8 px off their meta line.
- `.filter-days` doesn't wrap, so "days" never breaks into "da / ys".
- `label.settings-check` is a row (the box at the start, the words beside it), not a column under the box. `.settings-radios` that holds `.settings-check` rows is a column.

## Disclosures in shared panels (#360)

`More` (`components/shared.tsx`) is the disclosure for help or advanced controls on a panel both interfaces render: `<details class="k-more">` with the kit's summary. Modern starts it closed. Classic renders it open with its summary hidden, and `styles.css` lays `.k-more` (and a `.k-more-body` wrapper inside it) out as `display: contents`, so Classic's panel is the one it had. The sidebar uses it for the binder's **Import…** menu and **Filters**, what the quick scan checks, and the trace's privacy note. A dialog an action inside it opens stays outside it, so a closed disclosure never hides a question.

## For wave-2 work

- Use the classes above and don't restyle a control per surface. If a surface needs a variant, add it here, with a token, so every surface gets it.
- Restraint patterns (help on demand, an "Add…" disclosure) are `<details>` with the kit's summary: `<details><summary>More about this</summary>…</details>`.
- A setting that is on or off is a switch row: `<label><input type="checkbox" role="switch" …/> Words</label>`.
- A choice of two to four short options is a segmented control: a `role="radiogroup"` `.segmented` with `role="radio"` `.segmented-item` buttons carrying `aria-checked`.
