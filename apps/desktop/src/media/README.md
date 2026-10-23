# Media views (screenplay, branching dialogue, storyboard)

React views for the three media engines in the app: the screenplay scene, the storyboard board (with the video prompt
pack as its second tab) and the dialogue container. The centre pane mounts them (`components/Workspace.tsx`), and the
binder makes their nodes (`media/create-menu.ts`, through `binder.create`).

## What a writer can do

- **Make a node.** A chapter's context menu offers *New screenplay scene here*, *New storyboard here* and *New dialogue
  here*. A storyboard's offers *New shot here*. Each is a `binder.create`, so the bus checks the kind and the parent. A
  storyboard holds only shots, and a shot lives only in a storyboard: the bus refuses a move or a create that breaks either.
- **Write a screenplay scene.** The Script tab draws the scene as it reads; the Source tab edits the Fountain text, with
  the headings, cues, parentheticals, transitions and notes drawn in their own styles over it; the Pages tab shows the
  scene paginated, and a line of it opens its element in the Source tab. Enter at the end of a cue moves onto its dialogue, and Enter on an empty line after dialogue
  starts action. Tab completes a half-typed cue from the cues in the scene and the codex's characters. The element menu
  (the Element button, or Ctrl+E, Cmd+E on a Mac) rewrites the caret's line as the element chosen, through the screenplay engine's
  `convertLine` (element-menu.ts); a chord per element does the same from the text (*Known limits*, 3). All of these write through the session's autosave, which is the path the prose editor
  uses.
- **Write a dialogue container.** The Ink text sits under the outline, with its knots, stitches, choices, diverts,
  declarations and tags drawn in their own styles. Tab after a divert arrow completes the knot or stitch name. Clicking a
  card in the graph moves the caret to that knot's header in the text. Each choice's label is drawn on its arrow, and the
  choices list under the outline keeps it whole. The graph and the findings follow the text once the writer pauses (800 ms),
  and a codex change (an alias, a rename) is read at once. A compile error shows its line once. *Add line ids to N lines* asks first, then writes an id tag into each line that has none. A
  container whose `autoLineIds` is on also gets its ids when the writer pauses, and the caret stays where it was. The view is drawn once the Ink compiler has loaded (`components/InkGate.tsx`): a *Loading the Ink compiler…* status line until then, and
  **Try again** and **Reload** if it cannot be fetched.
- **Container settings.** The Inspector's *Container settings* section sets a dialogue container's default speaker (a
  codex character), its engine target, its line-id opt-in and its locale. Each change is a `dialogue.setMeta` command.
  The default speaker fills the speaker column of the dialogue table, and the line-id opt-in writes the missing ids into
  the Ink on save. The engine target picks the dialogue table's file: a `yarn-csv` container writes a Yarn Spinner strings
  file, and any other container writes the dialogue table. The locale fills each row's locale (the project's language when
  the container has none), and a container's own locale names its Ink story file (*Dialogue table and container settings*).
- **Import a script or an Ink story.** The binder's *Import script* reads a `.fountain` or `.fdx` file: its sections become
  folders, and its scenes become screenplay documents, in one undo step (`screenplay.import`). *Import Ink* reads a `.ink`
  file, and makes one branching container for each knot cluster, in one undo step (`dialogue.importInk`). Text above the
  first knot is not imported, and the status line says how many lines it was.
- **Read a finding's quote.** A quote on a finding opens its passage in place. A screenplay scene switches to its Source tab
  and selects the passage; a dialogue container selects it in its Ink text. The prose editor does the same for prose.
- **Work a storyboard.** Each card shows its picture (or its alt text), its shot number and one spec row, and the header gives
  the animatic total and how many shots are left out of it for want of a duration. *New shot* adds a card. The fields edit
  through `shot.setMeta`. A card moves by dragging it onto another, or with Earlier and Later; either is a `binder.move`.
  The card size control (S, M, L) is the corkboard's own, so one choice holds for both. S shows the number and the picture,
  M adds the title, one spec row (the four spec parts, then the lens and the transition) and the coverage line, and L adds the
  action, the status and the label (storyboard.md §3.1). At S the footer (Earlier, Later, Fields) is hidden but stays in the tab
  order, and it shows once focus reaches it. The shot editor names a camera value in words (*Bird’s-eye view*, *Dolly in*) and
  keeps the list's value underneath (`SHOT_ENUM_LABELS` in `@caotang/storyboard`). An empty storyboard gives the spec's copy.
- **Derive shots, from the scene and from an empty board.** A scene with no storyboard folder yet (`<Scene Title> — Shots`)
  offers *Derive shots from this scene* in its own view. An empty storyboard offers *Derive shots from “…”* for the one scene
  beside it that has no shots folder (`derivableSceneOf`), says that the shots go in a new folder named for that scene, and
  offers nothing when two or more scenes are open, or when it is a scene's own shots folder: derive makes a new folder, and
  `storyboard.create` does not refuse a title that is taken, so a second folder for a scene would be made. Both offers send the
  same request through `onAgentIntent`, which opens the agent drawer and submits it. The lookup and the request are unit-tested
  (`e2e/unit/media-storyboard-board.spec.ts`), and the offers and their request are checked in `e2e/media-storyboard-board.spec.ts`.
- **Put photographs of drawings on their shots.** Drop several picture files on the board, outside any card. Each file goes on the shot whose number its name starts with (`7.jpg`, `007.jpg`, `007-ferry.jpg`), the files are imported as one `shot.importImages`, so one Undo takes them all back, and a notice lists every file with the shot it went on or why it did not (`planPictureDrop` and `dropReportOf` in `shot-image-model.ts`; the rule is storyboard.md §6). The matching and the notice are unit-tested in `e2e/unit/media-storyboard-images.spec.ts`, and the drop in `e2e/media-storyboard-images.spec.ts`. The paper sheet the photographs come from is the contact sheet's *Paper frames* setting.
- **Give a shot a picture.** Choose a PNG, JPEG or WebP file in the shot's *Image* section, drop one on a card, or paste one
  while the card is selected. The file is kept in the project's images and the shot names it, as one undo step
  (`shot.importImage`). The section can also point the shot at an image the project already holds, or remove the picture. A
  picture opens larger in the lightbox, and Escape closes it. A picture whose file has gone is dropped when the project
  opens, with a notice on the open and on the board. Nothing is dropped against a list that cannot be trusted (no browser copy
  and no folder listed, or a listing that failed). A folder whose attach was refused is still read for its pictures, and a
  folder file that differs from the browser's copy counts as present, with the browser's copy shown.
- **Cover script text.** The *Script coverage* section shows a scene's or a prose document's stored text. Select words in it and
  cover them: the words are captured against the stored text, and the coverage is one `shot.setMeta`.
- **Write a shot's prompt.** The *Prompt* section writes one target model's record for the shot: its camera, subject, action,
  context and style, its audio, negative prompt, clip length, aspect ratio, resolution, seed, references and best take. Saving
  writes it through `shot.setMeta`, and the other models' records stay as they were. The checks under the fields are the
  engine's rows for this shot, and each one that names a field links to it.
- **Read the prompt pack.** The Prompt pack tab lists each shot's prompt for one target model, the references it sends, and
  which codex entries those references came from (and which entry was named but sent nothing, with the reason). Each check
  there links back to its field on the board. The three exports are the JSON, Markdown and CSV packs.
- **Compile.** The Compile dialog offers Fountain, Final Draft, the Ink story, the dialogue table, the shot list and the
  prompt pack for the selected item. Each compile is the bus's `export.compileSelection`, and a refusal (a line with no id,
  a selection with no scene, a prompt pack with no vendor template) is named in the dialog.

## How the centre mounts a view

`components/Workspace.tsx` asks `mediaViewFor(node, { session, ports, reveal, onRevealHandled, zoom, onZoom })` for the selected
node. `reveal` is a passage a finding quotes: the view that holds the document selects it and calls `onRevealHandled`. `zoom` and
`onZoom` are the card size the corkboard shares. `onAgentIntent`, which the scene's derive action and the empty board's derive action send
their request through, is passed by the centre: it opens the agent drawer and submits the request (*What a writer can do*, *Derive shots*):

| Node | View | Where it shows |
|---|---|---|
| document with `kind: 'screenplay'` | `ScreenplayView` | in the editor's centre, in place of the prose editor |
| dialogue container (`type: 'dialogue'`) | `DialogueView` | in the editor's centre, in place of the prose editor |
| folder with `kind: 'storyboard'` | `StoryboardView` | in place of the corkboard, which the board is in shot mode |
| a shot | none of its own | its storyboard shows, because a card is edited on the board |

Anything else returns `null`, and the centre shows what it showed before. A media document is never given to the prose
editor (`activeDoc` skips it), so the editor and a media view never hold one document at once.

Each view runs inside `MediaBoundary`, an error boundary, so a view that throws shows its fallback and the app keeps
running.

The storyboard, its prompt pack tab and the dialogue view are loaded when they are first opened (`React.lazy`, through
`lazyView` in `components/lazy-view.tsx`); the screenplay view is not, as it is small and its package is the store's. Each
view sits in a `LazyBoundary` inside `MediaBoundary`: a status line ("Loading Storyboard…") while the code arrives, and
**Try again** and **Reload** if it cannot be fetched. A browser may keep a failed import for the life of the page, so
Reload is the sure way out. The check in `e2e/lazy-views.spec.ts` holds a request, and refuses one, to show both.

`mediaPortsFor(session)` is the one port the centre passes: `commitShot`, which sends every storyboard command through
the bus (`commit.ts`), `importImage`, which stages a picture and runs `shot.importImage`, and `assets`, the project's images
as an artifact store (`session.assets.artifactFs()`). The images are kept in the browser's own asset store
(`packages/store/src/runtime/asset-store.ts`, its own IndexedDB database) and in the project folder when one is open, so a
card's picture survives a reload with no folder attached.

## Engine imports

`engines.ts` is the only file in this folder that names an engine package. The desktop declares `@caotang/screenplay`,
`@caotang/storyboard`, `@caotang/dialogue` and `@caotang/video-prompt-pack` as workspace dependencies, so the names are bare
specifiers.

One exception is open: `ScreenplayPreview.tsx` imports `paginate` and `LAYOUT` from `@caotang/screenplay` directly, because
`engines.ts` does not re-export them yet. Moving the two names into `engines.ts` removes the exception.

## What the store keeps

- A node's `kind`, a shot's `shot` metadata and a container's `dialogue` metadata are written to `caotang.json` on the
  node's line, and read back on load. An unknown kind string is kept; a metadata value of the wrong shape is dropped with
  a notice.
- A body is named for its kind: `docs/<id>.fountain` for a screenplay, `docs/<id>.ink` for a dialogue container, and
  `docs/<id>.md` for prose. A `.md` written before a kind had its own file still loads, and the next save writes the
  kind's file and removes that `.md`. A `.fountain` or `.ink` file no node owns is recovered as a screenplay or a dialogue container, under the
  manuscript's `Recovered` folder, where the binder shows it. A raw Ink file has no title of its own and is named
  *Recovered dialogue*.
- A body whose node is deleted is removed on the next save, whatever its extension, so it does not come back on reopen.
- A shot has no body. A dialogue container's Ink is written whole, with no front matter, because Ink has none.
- A codex entry's `visualRefs` (the asset ids a prompt pack sends with it) is written to `caotang.json` and to its codex file
  when there are some, and read back on load. The codex panel's *Visual references* section sets them, from the pictures
  already in the project, and removes them. The prompt pack names the pictures for the scenes the entry appears in; Caotang
  uploads none of them.

## What is not wired

1. **Shot images: the OS drag and the system clipboard are not driven.** `e2e/media-storyboard-images.spec.ts` dispatches a `drop` and a `paste`
   in Chromium, each carrying a real `DataTransfer` with real `File` objects, against the real handlers: a PNG or a JPEG lands through
   `shot.importImage`, a text file beside a picture is skipped, and a payload with no picture changes nothing. The spec asserts the files the
   `DataTransfer` holds before it dispatches. What is not covered is the gesture itself: that Explorer's or Finder's drag payload, or a
   copied image on the system clipboard, reaches `dataTransfer.files` and `clipboardData.files` in that shape. Try both by hand after a
   change to the handlers.
2. **Dialogue table and container settings.** The dialogue table's character limit (`charLimit`) is a recipe option, set in the
   export dialog's Character limit field when the dialogue table is chosen, so a `dialogue-csv` or `dialogue-xlsx` export from the app carries it.
   The engine target and the locale reach the exports (*What a writer can do*, *Container settings*). The agent's
   `dialogue.table` tool reads them too, but stays the one table: §6's columns plus `locale`, with the target and locale in its
   `data` and a note when the export writes a Yarn strings file. Its `charLimit` column is empty, because the tool has no recipe.
3. **Screenplay source affordances.** The element menu offers no section or synopsis: sections and synopses live in the binder and
   the Inspector (screenplay.md §2.2). Each of the nine elements has a chord in the Source tab: Ctrl+Shift+1..9, or Cmd+Alt+1..9 on a
   Mac, matched on the physical digit key. Playwright fakes the modifier state, so the chords are not checked on a real Mac, on a
   German or Polish (AltGr) layout, in Safari, or against Linux and IME hotkeys. A chord the system or browser intercepts still works
   from the menu.
4. **Coverage of a repeated passage.** The text area shows the stored text with line feeds, so a selection is always located
   by its words in the stored text, whatever its line endings. A passage that appears more than once is refused in every
   file, with how many places; the writer selects more words around the one meant.
7. **Page preview.** The Pages tab is `paginate()`'s output, and it is not the PDF. It writes nothing and cannot be typed on yet: a line that prints an element (its `LayoutLine.source`) is a button that
   opens the element in the Source tab, with the caret at its start, and generated lines have none. One line is in the tab order, and Up and Down move between them. The PDF is the `pdf` export
   format (screenplay.md §5.3), from the Compile dialog. The preview draws a dual-dialogue pair side by side, as the PDF
   does: the pair's two columns share their rows, and the blank rows stay collapsed, so the preview is not page-accurate.
8. **Ink line ids on import.** An imported container keeps the Ink as written. Line ids are minted by the Add line ids
    action or by a container whose `autoLineIds` is on, not by the import.
9. **The agent's derive plan is not verified.** The derive offers send their request to the agent (*What a writer can do*,
    *Derive shots*), and the plan the agent proposes for it, its folder and its shots, needs a model that proposes shots, which
    no test drives.

## Tests

`e2e/unit/media-*.spec.ts` test the view models and the pure rules without a browser: the screenplay units, the storyboard
cards, reorder and edit plans, the dialogue outline, graph and findings, the Ink save and confirm rules, the binder's
media entries, the prompt-pack preview, the routing, and the rebase and caret rules. `e2e/unit/media-storyboard-images.spec.ts`
covers picture files, the image commands, the animatic line and the durable asset store; `e2e/unit/media-storyboard-coverage.spec.ts`
covers the script choices, the captured anchors and the coverage commands; `e2e/unit/media-prompt-authoring.spec.ts` covers the
prompt draft and its record, the strict refusals, the vendor-preserving write, the field links and the codex consistency lines.
`e2e/media-nodes.spec.ts` drives the app: each node is made from the binder and opens in its view, the text survives a reload,
the graph follows the Ink, a shot is a `binder.create` and its fields survive a reload, and each of the five formats the Compile
dialog offers (Fountain, Final Draft, the Ink story, the dialogue table and the shot list) compiles. `e2e/media-rebase.spec.ts`
types, undoes and types again in each view, and checks that the second text survives a reload. `e2e/media-storyboard-images.spec.ts`
chooses a picture, drops and pastes PNG and JPEG files and non-pictures as real `File` objects, looks at it in the lightbox, keeps it across a reload, and drops a reference whose file is gone.
`e2e/media-storyboard-board.spec.ts` drags a card and checks the animatic header. `e2e/media-storyboard-coverage.spec.ts` covers
selected script text and removes it. `e2e/media-prompt-authoring.spec.ts` writes a prompt, follows a check to its field, and follows
a check on the pack tab back to the board. `e2e/media-prompt-provenance.spec.ts` sets an entry's visual reference in the stored
project (the app has no control for it yet), and checks that the pack names the entry the reference came from.

`e2e/media-reveal.spec.ts` clicks a finding's quote in a scene and in a container and reads the selection.
`e2e/media-board-controls.spec.ts` covers the card sizes, the mode switches' keys and names, the editor's words and the lightbox's
focus. `e2e/media-dialogue-views.spec.ts` covers the choice labels on the graph, the compile error's line and a codex alias that
clears a speaker finding. `e2e/unit/media-storyboard-board.spec.ts` and `e2e/unit/media-radio-keys.spec.ts` test the label lookup,
the derive scene and the radio keys without a browser.

```
CAOTANG_E2E_PORT=<your port> pnpm exec playwright test e2e/unit/media-
CAOTANG_E2E_PORT=<your port> pnpm exec playwright test e2e/media-nodes.spec.ts
CAOTANG_E2E_PORT=<your port> pnpm exec playwright test e2e/media-storyboard-images.spec.ts
```
