# Caotang user guide

This guide is for writers. It says what you see in Caotang and what each control does. For setup and the technical side, see the [README](../README.md). The last section lists what is not in this build yet.

## Your work and where it lives

Caotang keeps each project in your browser, which is where you write. A browser can clear its storage, so keep copies too:

- **A bundle** (`.caotang`). Choose **Export bundle** in the toolbar, or **Export** next to a project on the projects screen. Bring it back with **Import bundle (.caotang)**. A bundle can be imported into any copy of Caotang.
- **A folder** (Chrome or Edge). **Save to folder** writes the project as plain files. **Open a folder…** brings a folder in. A folder whose project this browser does not keep opens as its project, and saving writes back to the folder. A folder of a project this browser already keeps opens as that project when it holds the same book, and saving writes back to the folder too. If it holds a different version, Caotang asks which to keep: **Use the folder's version** replaces this browser's copy with the folder's, **Keep this browser's version and save it to the folder** opens this browser's copy and saves it there (asking first about any document it would write over), and **Open as a separate copy** opens the folder as a second copy with its own id, which cannot be saved into the folder. A project remembers the folder it was saved to: **Reopen folder** next to it on the projects screen opens that folder in one click, after your browser asks for permission, and opens the folder picker if the folder has moved. A folder of a project another tab has open is refused, as opening that project from the projects list is.

If a file in the folder has changed since Caotang last saved it, for example through an AI tool connected to the MCP server, Caotang asks before it saves, and nothing is written until you answer. The question names the files another program changed. **Save over them** writes this tab's version over them, and the folder's version isn't kept, so if you need anything from it, open the folder in another program and copy it first. **Save as a new folder…** saves the project into an empty folder you choose instead, and that folder is the project's folder from then on. A folder that already holds another project is asked about the same way: **Save over it** replaces that project's `caotang.json`, keeping a backup of it, and any of its documents that share an id with this one. A folder that holds an earlier save of this same project is not another project: if it is as Caotang last left it, saving goes straight in, even after a reload. If Caotang has no record of it, it asks first, in words that name this project. A second copy of a book, opened from that book's folder, still cannot be saved into it. When the project file itself changed, the old one is kept as a backup. A lock file in the folder, which the MCP server or a script using the SDK leaves while it runs, is a question too. If another program removed `caotang.json`, the question says so, and saving writes it back from this tab.

The folder also keeps its writing sessions, in `sessions.jsonl`. Opening the folder brings in the sessions this browser does not hold yet, and saving adds the sessions the folder does not hold.

Caotang asks your browser to keep its storage, but the browser decides. If it has not promised to keep your words, a banner says so. **Export a backup** keeps a copy, and **Learn why** says more about what the browser may do. **Settings › Data** names the storage location: this browser.

A project can be open in one tab at a time. A second tab waits a moment, then says the project is open in another tab. Switch to that tab, or close it, then open the project again. Opening a folder of a project that another tab holds is refused in the same way.

Undo of your typing in a scene survives a reload (redo may not). The toolbar's Undo and the Undo in Activity last while the tab is open, and a checkpoint can still take a turn back after a reload. Undo on a screenplay's Source tab and in Ink text is the browser's own, and a reload clears it. Caotang saves a moment after you stop typing (800 ms by default). If the tab closes or reloads before a save finishes, Caotang keeps the words in this browser and saves them when you open the project again, and says so. If the project has newer text by then, the words are offered in the binder footer instead, to put back as new documents or discard.

## Projects

- **Create.** On the projects screen, type a name under **New project**, then choose **Create project**.
- **Open.** Choose **Open** next to a project under **Projects in this browser**.
- **What an open says.** When a project or folder opens, Caotang says what it noted, in whole sentences. A field the file carries that Caotang does not use is named once, with its count, and the next save drops it. Smaller things are counted, so the note stays short. A document whose file is not UTF-8 pauses the open on a review: each file is named with the encoding its bytes look like, a preview you can check, and the choice to convert it or leave it as it is. Converting first saves the original bytes beside the project under `.caotang-backup/`. On a close call you can ask the AI — it reads a short excerpt through the Background role, and only suggests a reading.
- **Rename.** Choose **Rename**, type the new name, and choose **Save the name**. A rename has no undo.
- **Export.** Choose **Export** next to a project to save a bundle. When a project has changes since its last bundle, the projects screen suggests one, once. Dismiss the suggestion if you do not want one.
- **Import.** Choose **Import bundle (.caotang)**. If the project is already in this browser, the imported copy becomes a separate project with its own id. The original is not changed.
- **Remove.** **Remove** takes a project out of this browser. Export a bundle first if you may want it again. A folder you saved the project to is not touched.
- **Project details.** Choose the project's name in the toolbar. The title, author, language, ISBN and cover are set there. The author shows on the title page of Word and EPUB files, and the language, ISBN and cover go into EPUB files. The cover is kept in this browser, and also in the project folder when you save to one. Export a bundle to keep a copy. If the browser refuses storage, a cover lasts only while the tab is open. Use **Choose cover…**, **Replace cover…** or **Remove cover**.
- **A project that will not open.** If a folder's or a bundle's project file will not load, Caotang offers to rebuild the project from its documents. It asks first, and it says what the rebuild would lose. A project file that names another app, or a format newer than this version of Caotang reads, is refused instead: Caotang says so, writes nothing, and offers no rebuild.

## The binder

The binder is the list on the left, under the **Binder** tab. It has two sections:

- **Manuscript** holds your book. Chapters are folders, and scenes are documents inside them.
- **Research** holds notes. Research is never included in an export.

The buttons at the top of the binder:

- **New document** adds a scene to the selected chapter, or next to the selected scene. Ctrl+N does the same. With nothing selected, or only the manuscript, it makes no document and says that a document goes inside a chapter. The empty editor then offers **New chapter**.
- **New folder** adds a chapter to the manuscript.
- **Import script** reads a Fountain (`.fountain`) or Final Draft (`.fdx`) script. Its sections become folders and its scenes become screenplay scenes, in one undo step.
- **Import Ink** reads an Ink story (`.ink`) and makes one dialogue container for each group of knots that divert to one another. Text above the first knot is not imported. The status line says how many lines it was, so you can copy them by hand.

Keep scenes inside chapters. A drag cannot place a scene directly under the manuscript, and a scene that sits there, such as one put back from a stopped tab, has no chapter heading when you export. Move it into a chapter.

On each row:

- Click a title to select it. Double-click the title, or press F2, to rename it.
- Drag a row to move it. Drop it on the top or bottom quarter of another row to put it before or after that row. Drop it on the middle of a chapter to put it at the end of that chapter.
- Click the status chip to set **Draft**, **Revised**, **Final**, or none. Every new project has these three. Choose **+ Add status…** to add your own.
- Click the label chip to set a label. A new project has no labels. Choose **+ Add label…** to add one. Both lists open in the same **Statuses and labels** dialog.
- Right-click a row for **Open in editor**, **New document here**, **Edit synopsis**, **Rename**, the move entries and **Delete…**. A chapter also offers **New screenplay scene here**, **New storyboard here** and **New dialogue here**. The manuscript itself does not, because a document goes inside a chapter. A storyboard offers **New shot here**. A section offers **New folder here**.
- The arrow keys move the selection between rows. Alt+Up and Alt+Down move the selected item among its neighbours. Alt+Left takes it out of its folder, and Alt+Right moves it into the folder above. **Delete** asks first. After a delete, focus goes to the item that takes the deleted one's place. Ctrl+Z, or **Undo**, brings the deleted item back right after.

### Filter the binder

The filter bar above the list narrows it. Type to filter by title, synopsis or text. Then choose a status, a label, a minimum and a maximum word count (Chinese, Japanese and Thai words are counted the way the browser divides them, so those counts are approximate), keywords that must all match or any that match, or a change or creation within a number of days. The binder shows exactly what the bar matches.

- **Save current…** keeps the filter under a name. Give it a name and choose **Save filter**. When a saved filter is applied, the button reads **Update saved filter…** instead.
- **Clear** removes the filter.

### The footer under the binder

- **Saved filters.** Choose a filter's name to apply it. **Edit** applies it so you can change it, and **Delete** removes it.
- **Goals.** The footer shows the nearest project goal by its deadline, with how far you are and how fast you need to write from here. Choose that line to select the goal's item. Goals are added, changed and removed in the inspector, described under [The inspector](#the-inspector).
- **Sprint.** Set the **Minutes**, then choose **Start sprint**. **Pause** (then **Resume**), **Stop** and **Reset** work as their names say.
- **History.** Choose **Show the history** to see **Today**, **Daily average** and **Daily best**, counted across every project in this browser. **Today** includes the sitting that is open, so it matches the status line. **Download CSV** saves the record.
- **Kept from a stopped tab.** This appears when a tab stopped because another tab saved newer text for the project. The words that tab held were kept in this browser, and the block says when. **Put them back as new documents** adds them to the chapters they were in. A Research note goes back to the Research folder it was in. A document whose chapter (or Research folder) is gone goes into a new chapter, **Kept from a stopped tab**, at the end of the manuscript. **Discard them** removes them.

## The corkboard

Choose **Corkboard** above the centre of the window to see the cards of the selected chapter, or of the manuscript's chapters when **Manuscript** is selected. **Editor** goes back to the text.

- Drag the grip (⋮⋮) on a card to reorder it. Drop on the left half of a card to go before it, or the right half to go after it. Drop on the empty space to go to the end. Alt+Left and Alt+Right move the selected card earlier or later.
- Choose **S**, **M** or **L** for the card size. Small cards show the title. Medium cards add the synopsis and status. Large cards add labels and keywords. Changing the size changes only the view.
- **New card** adds an item to the board you are looking at. On the Manuscript board the new card is a chapter, so add scenes inside a chapter instead.
- Double-click a card's title to rename it.
- On a focused card, the arrow keys move the focus to the previous or next card. Enter or Space selects the card, F2 renames it, Delete asks to delete it, and Shift+F10 opens its menu. After a delete, focus goes to the card that takes its place.

When a storyboard is selected, its board of shot cards takes the place of the corkboard. See [Planning a storyboard](#planning-a-storyboard).

## The inspector

The panel on the right shows the selected item:

- **Synopsis**: a short summary, up to 2,000 characters. It saves when you pause typing.
- **Notes**: free-form notes on a scene, kept out of the manuscript. Folders have no notes.
- **Keywords**: type one and press Enter.
- **Goals**: for a folder, or for the manuscript. Choose the **Comparison** (**At least**, **At most** or **About**) and the **Measure** (**Words** or **Characters**), type the target, and choose an optional **By** date for a project goal. On the manuscript, **Kind** also offers **Weekly** and **Monthly**. A weekly or monthly goal counts the words of the sessions that ended in the current week or month, across all your projects in this browser. Choose when it starts with **Week starts on** (the first day of the week where you live, unless you pick another day) or **Month starts on** (the 1st, unless you pick a day up to the 28th or the last day of the month). Choose **Add goal**, then **Edit** or **Remove** beside a goal to change or delete it.
- **Status and label**: the menus described above.
- **Export style**: for a scene, **Normal** or **Section**. A scene marked **Section** prints its title as a heading above it when you export (see [Export](#export)). **Normal** clears it. Undo puts the last choice back.
- **Codex**: the codex entries attached to the item, with **Attach a codex entry**. The **Mentioned in this document** list shows the codex names the text contains.
- **Scene declarations**: for a scene, its **Point of view**, **Day offset**, **Duration in days** and **Timeline mode** (Linear, Flashback, Flash-forward, Parallel, Frame, Dream, Mythic, Backstory, Simultaneous, Circular or Time skip), the scenes listed under **Follows these scenes**, and the codex entries listed under **Expected to appear**. The continuity checks read these. Under **Threads this scene sets up** you can name something this scene plants (a **Thread name**, for example "the lamp"), choose the scene it is **Paid off in**, and add a line on **What the payoff is for**. Choose **Edit** to change a thread and **×** to remove it. Under **Knowledge** you can say which character **Learns** a fact in this scene and which is shown to **Know** it. Pick a character and a fact and choose **Add**; **×** takes a pair off. The facts are kept in the Knowledge list of the Findings tab, and a character is a codex entry of type character. **Dialogue container** links a screenplay scene to a dialogue container, so a scan can compare the characters the two name (see **Speakers in a screenplay and its dialogue** below); choose **No dialogue container linked** to clear it.
- **Container settings**: for a dialogue container, described in [Writing dialogue](#writing-dialogue).

## The editor

Select a scene in the binder to write in it.

- Scenes are saved as Markdown files, so they stay readable outside Caotang. A screenplay scene and a dialogue container have their own views, described below.
- Caotang saves as you type. The toolbar says **All changes saved in this browser** once it has. The pause before a save is 800 ms by default. **Settings › Writing** changes it, for the projects you open after you save.
- If a scene holds Markdown that Caotang would save differently, a notice names it when the scene opens. Your text is kept.
- The footer under the editor shows the scene's word count (for Chinese, Japanese and Thai it follows the browser's word segmentation, so it is approximate and can differ between browsers; a goal in characters is exact), a session ring that fills toward your daily target, and whether the scene is saved. Choose the ring or today's line to set the target there. Zero clears it.
- **Ctrl+Z** undoes your typing in the scene, one burst at a time, and still does after a reload. An agent's draft is never part of it. The **Undo** button in the toolbar takes back the last change Caotang made, such as a move or a deletion.
- **Focus** in the toolbar, or Ctrl+Shift+F, hides the binder and the inspector and leaves the text. **Settings › Writing** has the setting **In focus mode, hide the binder and the inspector**. When it is off, focus mode leaves the panels shown. The status line says so when you turn focus on, and its **Settings › Writing** opens that setting. The Focus button stays on the toolbar, so you can leave focus mode from it.
- When the agent drafts a scene, its words appear in the scene as they are written, and a draft preview bar offers **Apply**, **Retry** and **Discard**. See [The agent](#the-agent).
- The window needs at least 960 px of width. Under 1100 px the toolbar wraps onto a second row, and the side panels narrow.

## Writing a screenplay

Choose **New screenplay scene here** from a folder's menu. A screenplay scene is written in Fountain, a plain-text screenplay format. Its view has three tabs:

- **Script** draws the scene as it reads.
- **Source** is the Fountain text. Headings, cues, parentheticals, transitions and notes are drawn in their own styles as you type.
- **Pages** shows the scene paginated, as a preview: you do not type on the page. Choose a line, by click or with Up and Down and Enter, and the Source tab opens with the caret at the start of the element that line prints, so a wrapped paragraph opens at its first word. Page numbers, scene numbers, (MORE), (CONT'D) and the title page are drawn by Caotang and open nothing. A dual-dialogue pair stands side by side, as in the PDF, but the blank lines between elements are closed up. To get a PDF, compile the screenplay as **Screenplay PDF**.

On the Source tab:

- Enter at the end of a character's name (a cue) moves onto the line for its dialogue.
- Enter on an empty line after dialogue starts an action line.
- Tab completes a half-typed character name from the names cued in the scene and the characters in the codex.
- **Element**, above the text, or Ctrl+E (Cmd+E on a Mac), opens the element menu for the line the caret is on. It lists **Scene heading**, **Action**, **Character**, **Parenthetical**, **Dialogue**, **Transition**, **Centered**, **Note** and **Page break**, and marks the one the line is. The arrow keys move through it, and Enter chooses. The digits 1 to 9 choose an element directly.
- **Ctrl+Shift+1** to **9** (**Cmd+Alt+1** to **9** on a Mac) do the same without opening the menu: the caret's line becomes the element that has that digit in the menu. A line that already is that element stays as it is. A line that cannot be it, such as dialogue with no character above, is left alone, and the status line says so. The menu shows each chord beside its digit. A chord your system or browser keeps for itself does nothing in the text, and the menu still works. Holding AltGr with a digit types the character your keyboard layout has there.
- Choosing an element rewrites the line in its Fountain form. Your words are kept. Caotang adds a mark such as `.`, `@`, `!` or `>` only where the line would otherwise read as another element. A heading, a character or a transition under other text gets a blank line above it. **Parenthetical** and **Dialogue** are offered only under a character. **Page break** on a line with words puts the break on its own line above it.

When Caotang saves a scene, it writes Fountain in the standard layout: a run of blank lines becomes one blank line, and Windows line endings become the usual ones. Your words are kept.

Compile a screenplay from **Compile…**, in the Media group, as Fountain, as Final Draft (`.fdx`) or as a PDF. Final Draft files have not yet been checked against Final Draft itself; see [What is not in this build yet](#what-is-not-in-this-build-yet).

### The screenplay PDF

**Screenplay PDF (`.pdf`)** sets the script on US Letter pages in the standard screenplay layout:

- The font is Courier Prime at 12 point. It is inside the file, so the pages look the same on every computer and printer.
- The margins are 1.5 inches on the left and 1 inch on the other three sides.
- Scene headings and action run the full width. Character names, parentheticals and dialogue sit at their usual indents. Transitions are set flush right.
- The title page comes first when **Title page** is on. It shows the project's title, the author and the date. It has no page number.
- Script pages count from 1. The number is printed at the top right from page 2.
- A scene heading is never left alone at the foot of a page. A character name always stays with its first line of dialogue. A transition never starts a page.
- A speech that crosses a page breaks after a sentence. **(MORE)** ends the page and the name returns with **(CONT’D)** on the next one. You can turn this off in the recipe: clear **(MORE) and (CONT’D) where a speech crosses a page**.
- Dual dialogue (a second name marked `^`) is printed side by side, in two columns. The Pages view draws it the same way.
- **Scene numbers** can be printed in the left margin, the right margin or both. They are off unless you choose them. A heading's own number, such as `#24A#`, is used when it has one.
- Notes (`[[…]]`), boneyard text (`/* … */`), sections and synopses are not printed.

Courier Prime covers Western European letters and the usual punctuation. Other characters, such as Chinese, Japanese and Korean, print in Noto Sans Mono CJK SC. Only the characters the script uses go into the file. A script with no such character does not load this font.

A Chinese, Japanese or Korean character takes the width of two Courier letters. A line can break between Chinese or Japanese characters without a space, but not before a closing mark such as `。` or `」`. Korean breaks at spaces.

Emoji print in Noto Emoji, a black-and-white emoji font. An emoji takes the width of two Courier letters, however it is built: a family such as 👨‍👩‍👧, a flag such as 🇩🇪, a keycap such as 1️⃣ or a skin tone such as 👍🏽 is one picture, and it is never split across lines. A line can break before or after an emoji without a space. The font has no colours and no skin tones, so 👍🏽 prints as 👍, but text you copy out of the PDF keeps the emoji you typed. A script with no emoji does not load this font.

Arabic, Persian, Urdu and Hebrew print in Noto Sans Arabic and Noto Sans Hebrew, which are loaded only for a script that has them (0.15 MB and 0.02 MB). Letters take their joined forms, and a word takes whole Courier columns, rounded up, with the spare room on the side the word ends. A line that mixes these scripts with Latin letters, digits or emoji is ordered the way Unicode's bidirectional rules put it, and brackets turn to face the right way, so `(בשקט)` has its parentheses the right way round. A paragraph's direction is that of its first strong letter; a paragraph with none, such as a number or `...`, takes the direction of the project's language (Arabic, Persian, Urdu, Hebrew or Yiddish read right to left). A right-to-left paragraph ends at the right edge of its own column, inside the same page as any other: the margins, the page numbers, the transitions and the order of dual dialogue are not mirrored. These scripts have no capitals, so a character name in them needs a `@` in front, as in `@سارة`. A speech splits after `؟`, `۔` or `؛` as well as after the Latin stops. Copying text out of the PDF gives back the words as you typed them.

Hindi, Marathi, Nepali and Sanskrit print in Noto Sans Devanagari, which is loaded only for a file that has Devanagari (0.18 MB). Conjuncts such as क्ष, त्र and द्ध, the short ि drawn before its consonant, reph and the marks that stack on a letter take their proper shapes, in the form of the project's language (Marathi and Nepali use other forms of some letters than Hindi does). A word takes whole Courier columns, rounded up, so these lines do not look typeset. A line breaks at spaces, and a word wider than the column breaks only between syllables, never inside a conjunct. A speech splits after `।` and `॥` as well as after the Latin stops. Devanagari has no capitals, so a character name in it needs a `@` in front, as in `@राम`. Copying text out of the PDF gives back the words as you typed them. These pages were checked by tests that read the file back, not yet by a reader of the language.

Marks that sit on a letter (the Arabic harakat and shadda, the Hebrew points and cantillation) are left out of the print, because their place in the font cannot be checked yet; the file still holds them as text, and the compile log says how many were left out. Nastaliq, the style of Urdu in Pakistan, is not drawn: Urdu prints in the plain Arabic style. These pages were checked by tests that read the file back, not yet by a reader of the language.

A character no font has prints as a question mark, and the compile log names it. Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam and Sinhala are among them: only Devanagari has a font so far.

The PDF is made in your browser. Nothing is sent anywhere.

## Writing dialogue

Choose **New dialogue here** from a folder's menu. A dialogue container holds an Ink story: knots, stitches, choices, diverts, variables and tags.

- **The Ink text** sits under the outline. Knots, stitches, choices, diverts, declarations and tags are drawn in their own styles.
- **Branch graph.** Each knot is a card. Click a card to move the caret to that knot's header in the text.
- **Outline and findings.** The structure of the story and what the checks found. Both follow the text when you pause, about 800 ms after your last keystroke.
- Tab after a divert arrow (`->`) completes the knot or stitch name you started.
- **Add line ids to N lines** asks first, then writes an id into each line that has none. With **Add line ids on save** turned on, Caotang writes the missing ids each time it saves.
- **Container settings**, in the inspector: **Default speaker** (a codex character, who fills the speaker column of the dialogue table), **Engine target**, **Add line ids on save**, and **Locale** (the language the text is written in, such as `en` or `en-GB`).
- If the Ink does not compile, the view says so and lists the errors. Fix them in the Ink text.

Compile a dialogue container from **Compile…**, in the Media group, as an Ink story (`.ink.json`) or as a dialogue table (`.csv` or `.xlsx`): each spoken line with its id, speaker, text and locale.

The container settings change these files:

- **Engine target** picks the table. A container set to **Yarn string table (CSV)** goes into a Yarn Spinner strings file, `<name> (dialogue, Yarn).csv`, with Yarn's columns and `line:` ids. Any other target, or none, goes into the dialogue table, `<name> (dialogue).csv`. A compile that holds both kinds writes both files. The Ink story is the same for every target.
- **Locale** is written on each line of both tables. A container with no locale uses the project's language. A container with its own locale puts it in the Ink story's file name, such as `Tavern.de.ink.json`.
- The Yarn strings file has no character limit column. Its `lock` column holds the first 8 hex characters of the SHA-256 of the line's `text` cell, the hash Yarn Spinner for Unity writes, so a translated row whose base text changed shows a different lock. It is a localisation file for a Yarn project whose lines carry Caotang's `#line:` ids, not the base-language strings Yarn generates from its own scripts.
- In the Yarn strings file, a line or choice whose text cell starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front, as in every CSV export, so a spreadsheet does not run it as a formula. A spoken line's cell starts with the speaker's name when it has one. The apostrophe is written into the cell itself, so a tool that reads the file gets it with the line; Caotang has not checked how Yarn Spinner shows it. The language, file and comment cells get the same guard.

## Planning a storyboard

Choose **New storyboard here** from a folder's menu. A storyboard holds shots, and each shot is a card. Choose **New shot here** to add one.

- **Board** shows the cards. **Prompt pack** shows the video prompts for one target model.
- The header gives the number of shots, the animatic total in seconds, and how many shots are left out of that total because they have no duration.
- Each card shows its picture, or its caption when there is no picture, and its shot number. Select a card to edit its fields: **Shot size**, **Camera angle**, **Camera movement**, **Transition out**, **Lens**, **Duration, seconds**, **Action** and **Caption when there is no image**. Choose **Save shot**.
- Move a card by dragging it onto another card, or with **Earlier** and **Later**. The shot numbers follow the order.
- **Shot card size** sets how much each card shows. **S** shows the shot number and the picture. **M** adds the title, the camera details (in the words the shot editor uses, such as “Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s”, with the lens and the transition after them) and the script coverage. **L** adds the action, the status and the label.
- An empty board offers **New shot**. When the board sits beside exactly one screenplay scene that has no shots yet, it also offers **Derive shots from “Scene”**, which asks the agent to propose the scene's shots from its script. They go in a new folder, “Scene — Shots”, not on this board. This needs a provider in Settings › Providers, because the built-in demo provider does not derive shots.

**Pictures.** In a shot's **Image** section, choose **Choose an image file** (PNG, JPEG or WebP). You can also drop a picture on a card, or paste one while the card is selected. **Or use an image already in the project** points the shot at a picture the project holds, and **No image** removes the shot's picture. The picture is kept in this browser, and also in the project folder when you save to one. Export a bundle to keep a copy. If the browser refuses storage, a picture lasts only while the tab is open. Select a picture to see it larger, and choose **Close** or press Escape to return. A picture whose file has gone is dropped when the project opens, and a notice says so when it opens and on the board. A folder that Caotang cannot save exports to is still read for its pictures.

**Script coverage.** In a shot's **Script coverage** section, choose a scene or a document, select the words of its text that the shot covers, then choose **Cover the selected text**. **Remove** takes a coverage back. If a passage appears more than once in the text, in any file, Caotang refuses it and says how many places, so select more words around the one you mean. A selection across a line break is covered.

**The shot's prompt.** The **Prompt** section writes one target model's prompt for the shot: its camera, subject, action, context and style; its audio; the negative prompt; the clip length, aspect ratio, resolution and seed; and its references. Use **Vendor for this prompt** to choose the model. **Save prompt** saves that vendor's prompt, and the other vendors' prompts are kept as they were. The text you type for one vendor stays when you switch to another vendor and back. A change to the stored prompt, such as an undo or the agent's draft, can replace it, and then the section says so. **Remove this prompt** deletes it. Each check under the fields names a problem, and **Go to the field** brings that field into view. **Writer's note for this shot** is for you, and it is not sent to the model. **Add a reference** adds a codex entry or a picture the prompt sends with the shot, and **Best take** records the take you kept from your own generation.

**Contact sheet.** Arabic, Persian, Urdu and Hebrew print on the sheet too, ordered right to left where the line runs that way, and a right-to-left line ends at the right edge of its box. So do Hindi, Marathi, Nepali and Sanskrit, shaped as in the screenplay and cut with the ellipsis between syllables, never inside a conjunct. To print a storyboard, choose **Compile…** and **Storyboard contact sheet (.pdf)**, with **Only “…”** for one storyboard or **The whole manuscript** for every shot. The PDF lays the shots out as cards in board order, 15 to an A4 page or 12 to a US Letter page. Each card shows the picture, the shot number, the camera details and duration in the shot editor’s words (on up to two lines), and the first two lines of the action. Each page's header gives the project, the storyboard, the date, the page number, the number of shots and the animatic total. A shot with no picture shows its caption. **Paper size** in the recipe's settings chooses A4 or US Letter.

Chinese, Japanese and Korean text prints in the Noto Sans Mono CJK font. Lines break between Chinese and Japanese characters, and at spaces in Korean. Caotang loads the font only when a sheet holds such text, and the PDF carries only the characters it uses. Greek and Cyrillic print in the same font.

Emoji print too, in black and white, in the Noto Emoji font: every emoji up to Unicode Emoji 17.0 prints. A family, a profession, a skin tone, a flag or a keycap prints as one picture and wraps as one character, and copying it out of the PDF gives back what you typed. Caotang loads this font only when a sheet holds an emoji. Skin tones print as the plain figure, since the font has no colour, and the people "facing right" (🚶‍♀️‍➡️) print as one figure facing right, without a gender sign, as 🚶‍♀️ prints without one.

**The prompt pack.** The **Prompt pack** tab lists each shot's prompt for one **Target model**, the references it sends, and the codex entries those references came from. Each check links back to its field, and **Fix on the board** opens the field. Export the pack from the tab as a **JSON pack**, a **Markdown pack** (with a Consistency block for each shot that names a codex entry, listing the entries that sent references and those that sent none) or a **CSV shot list**. Export is held while a row is an error, so no file is written from a prompt the model would refuse. Caotang never sends anything to a video service. You paste the prompts into your own tool. The Compile dialog also offers the pack, as **Prompt pack (video)** (see [Export](#export)): it writes all three files at once.

## The codex

The codex is your reference book: characters, locations, objects, lore, subplots and anything else the agent should know. Open it from the **Codex** tab on the left. Choose **New entry** to add one, or type in the search box to find one.

Each entry has a name, optional aliases (**Add an alias and press Enter**), a type (**Character**, **Location**, **Object**, **Lore**, **Subplot** or **Other**), a description of up to 2,000 characters, an include policy, **Exclude phrases** (a match inside one is ignored), and the documents it is attached to.

The include policy says when the agent sees an entry:

- **Always**: with every request. These are sent whole even when together they are longer than the codex's share of the prompt; the other entries are then left out, and the prompt preview says how many tokens the Always entries need.
- **Detected**: when its name or an alias appears in the text being written.
- **Manual**: only in the documents it is attached to, and in the documents inside a folder it is attached to.
- **Never**: never sent to the agent. Use it for spoilers and private notes.

The **Appears in** list shows each document where the name or an alias occurs, with the count. An entry the agent drafted says **Drafted by the agent**, and an entry you imported says **Imported**.

**Visual references.** The **Visual references** section chooses pictures that are already in the project, from the **Add a picture** menu, and each one can be removed. The prompt pack names those pictures for the scenes the entry appears in, so you can attach them in your video tool. Caotang uploads none of them. When the agent proposes an entry with visual references, its card names each picture by its file name, and says so when a picture is no longer in the project.

## Findings

The **Findings** tab checks the manuscript. It has two kinds of check:

- **Scan the manuscript** runs the quick checks you turned on under **Settings › Coherence**. It does not read the story for plot or character problems. A scan changes nothing in the text.
- **Review with agent** reads the story for plot and character problems with your provider. It first shows a plan: which documents it reads, about how many model calls and tokens it needs, the first prompt it sends, and a cost when your provider profile has a price. It runs only after you choose **Start the review**. **Stop the review** ends it. The demo provider cannot do this review, so connect a provider first. The review sends each scene only the codex entries its include policies select for that scene, so an entry marked **Never** is not sent.

Choose the **Scope**: **This document**, **Changed since the last scan**, or **Whole manuscript**. A scope of more than 20 documents asks first: the status line asks, and the panel shows **Scan it anyway**. **Scan it anyway** runs the scope that asked, and **Run again** on a large scope asks the same way.

A scan also checks the threads you declared. If the scene a thread is **Paid off in** has since been deleted, the scan warns, and says what the scene declares rather than that the story is wrong. If that scene exists but the scan did not read it (it is empty or archived), the scan notes it instead. The scan report says how many scenes declare a thread, so a quiet result is not taken for a clean one.

A scan also notes two scenes whose day offsets are a week or more apart, one after the other in day order. If the jump is meant, set the later or earlier scene's **Timeline mode** to **Time skip** (a **Dream** or **Mythic** scene also silences it), or dismiss the note.

Findings are grouped as **Errors**, **Warnings** and **Notes**. **Show** filters them to **Open**, **Dismissed**, **Marked fixed** or **All**. Each finding quotes the passages it is about. Choose a quote to see that passage in its scene. On an open finding:

- **Fix with agent** starts a turn in the agent to rewrite one passage. The passage is the first quote in the binder: the one in the document that sits higher in the binder, and in that document the earlier one. A finding whose first quote is in a dialogue container has no Fix, so edit that passage in the Ink text. The agent drafts prose and screenplay scenes, not dialogue. On the demo provider, Fix with agent rewrites only the demo's own sample passages, and it refuses any other.
- **Mark fixed** closes the finding.
- **Dismiss…** asks you why, and its picker takes focus. Cancel returns focus to the **Dismiss…** button. Dismissing is your call.

### Knowledge

Something a reader is told is not always something a character knows. The **Knowledge** list, under the findings, holds the facts you want to track through the cast, such as "Mara is the heir". Type a fact under **New fact** and choose **Add fact**. **Edit** changes its words and **Remove** takes it away together with every declaration of who learns or knows it (the list says how many), and Undo puts all of it back. Under each fact the list shows where a character learns it and where one is shown knowing it; each scene is a button that opens it.

You say who learns and who knows a fact on the scene, in its **Scene declarations** under **Knowledge**. A scan then reports a character who knows a fact in a scene before any scene at or before it teaches them. It names both scenes, or says that the character never learns it. The check reads only what you declared:

- The order is the binder's, unless both scenes have a **Day offset**, and then the days decide. A flashback that teaches a secret on an earlier day counts as before a present-day scene.
- A scene whose place in the story is not known, such as a flashback with no **Day offset**, is left out, and the scan report counts it as not compared.
- A **Dream** or **Mythic** scene teaches no one, and what it shows a character know is not checked.
- A scene that is empty or archived is not read.

The scan does not look for the fact in a character's lines or in the prose. Dismiss a finding with a reason when the early knowledge is meant, for example a character who guessed.

### Speakers in a screenplay and its dialogue

A screenplay scene and a branching dialogue can name the same people in different ways, such as "Marisol" in one and "Marisol Vega" in the other. Nothing pairs a scene with a dialogue until you do: in the scene's **Scene declarations**, choose a **Dialogue container**. A full scan then compares the characters the scene's cues name with the speakers of that container, and notes where the two differ:

- a screenplay spelling and a dialogue spelling that look like one name, where the codex knows only one of them or holds them as two characters;
- a character only the screenplay has, or only the dialogue has.

These are notes, not errors: a branch may rightly give a character a line the flat script lacks, so dismiss a note with a reason when the difference is meant. Only speakers are compared, never the lines or what they mean. A scene with no link is not compared, and the run history says how many scenes were compared and how many were not. A link to a container that is archived or gone shows as missing in the Inspector, with a button to clear it. Only screenplay scenes are compared.

The **Run history** lists each run. **Run again** repeats a run with the same scope and the checks you have on now. **Discard run** removes a run, and Undo puts it back. The Export dialog's Review group writes the findings and runs as a coherence report, in Markdown or JSON.

## The agent

Choose **Agent** at the bottom of the window to open the panel. The line at the top of the panel names the provider the agent runs on, or says **No provider**. **Hide the agent** closes it.

Type what you want in **Intent**, then choose **Send**. With a provider you have added, you can ask for anything that provider can answer. The built-in demo provider answers only three requests, which run on a sample manuscript. You find them on the first-run card under **Try the agent with no key** on the projects screen, and as buttons in the agent panel before its first turn when the demo is in use. When it cannot make its draft or fill its synopses, it says so in words, and nothing changes.

The Intent box stays open while the agent works. **Enter** queues what you type as the next turn, and **Ctrl+Enter** (Cmd+Enter on a Mac) sends it to the turn that is running as a note, which the agent reads at its next step. **Stop**, in the header while a turn runs, ends the turn; so does **Esc** with the Intent box empty. With text in the box, Esc leaves the turn alone. The turn stops at its next step: what it already applied stays, the turn's checkpoint can still restore it, and the report says "Stopped by you." A card that is waiting is cancelled, as **Cancel** does. A step that has started is not interrupted: a change that is being applied, and a compile, finish first.

Queued messages show under the box as **Queued messages**. Each can be edited, removed, moved with ↑ and ↓ or by dragging, or sent now to the running turn with **Steer now**. They run one at a time, each after the turn before it has ended, and a queued message is never joined to another or to a note. If a turn ends on a question, the queue waits: answer the question or choose **Run the queue**. A note typed while a card waits does not go at once, because the card is yours to decide: choose **Send with Cancel** to cancel the card and give the agent the note, or **Queue as next turn** to keep the card and run the note after the turn. A note the agent did not read before its turn ended becomes the first queued message.

The agent remembers your last two requests in this tab: what you asked and what came of it, a changed passage or the answer it gave. The drafts it writes are given them as background, and changing the provider, the model or the thinking level in between does not clear them. Closing or reloading the tab does.

Reading the agent's work:

- **Progress.** While the agent works, the header of the agent panel says where it is: "Step 3 of 5 · Drafting “The Landing”", or "Waiting for you · Plan, 3 steps" when a card needs you. It shows with the panel open or closed. At the top of the turn, a checklist lists the steps with one in progress, each marked in words as Queued, Waiting for you, In progress, Done, Skipped or Failed (a failed step gives its reason). A step you drop from the card is Skipped, and so is a step that did not run after a failure or a cancel. The checklist folds when the turn ends and stays in the turn. Under it, **Model calls: 3 of 8** counts the requests the turn has made to the model; at 7 and 8 it turns to a warning, and at 8 the turn stops and asks you how to go on. The list is built from the agent's plan and its calls, not by asking the model, so it never shows a step as done that did not run.
- **Plan card.** The agent lists its steps. Move a step up or down, drop a step, or change the settings of a drafted step. Then choose **Approve plan**, or **Cancel**. Nothing in the plan is written until you approve it.
- **One-step card.** A single change shows a card with **Approve**.
- **Coherence review.** The agent can plan a model review as one step. It shows the plan on a card, and it reads the manuscript only after you approve.
- **Background tasks.** When a plan needs five or more model calls, the agent asks before it starts: **Run now**, **Run in background** or **Cancel**. **Run in background** makes the same calls one at a time while you keep writing, and the agent is free for your next message. The **Background tasks** list in the agent panel shows each task in words (waiting, drafting, ready to review, failed, cancelled, stopped or applied), how many calls it has used of the most it may make, and why anything failed. Nothing is written until you choose **Review** on a ready task: it opens the usual card, with each draft on screen in its scene, and **Approve** applies them as one change that the checkpoint can restore. A scene you changed since it was drafted is marked out of date, and its step cannot be approved until you retry the draft or drop the step. **Cancel** stops a task, **Resume** finishes a stopped one, and **Dismiss** removes one from the list. A task is drafted only while the project is open in this tab.
- **Drafts.** The prose the agent writes appears in its scene while the model writes it. A draft preview bar in the scene holds the draft, with **Apply**, **Retry** and **Discard**. **Apply** writes the draft into the scene, and **Discard** leaves the scene as it was. If **Apply** or **Approve** is greyed out, open the scene: the card waits until its draft has been on screen. A draft cut off at the model's output limit is marked, and its card can offer **Approve and keep the cut text** or **Retry draft**.
- **Small changes.** A single status, label, keyword or note change runs at once, with no card. Each turn that changes the project leaves a checkpoint row.
- **Reads.** A check needs no approval. The agent's read-only answers appear in the panel.
- **Notes, synopses, statuses, filters and goals.** The agent can rewrite a document's notes, set a synopsis, add or change a status or a label, save a binder filter and set a word goal. Setting a synopsis, saving a filter and setting a goal run at once, like a status change, and each can be undone. Rewriting the notes and changing the statuses and labels show a card with **Approve**. The notes card shows the old and the new notes word by word, with added words underlined and removed words struck through, so you read the change before the notes are replaced. **Undo** puts the old notes back exactly. A plan can add a status and then give it to a document in the same approval.
- **Tools.** The agent starts each request with a short list of tools and finds the others with a search when a task needs them. With a dialogue container or a storyboard open, that module's tools are there from the start. **Settings › Agent** has **Load every tool on every request** for a model that searches poorly. It is off by default, and it makes every request longer.
- **Connected tools.** The agent can call the tools of the MCP servers you have connected and enabled in **Settings › MCP & tools**. A call runs at once only when its server is trusted for reads and the tool is read-only. Any other call shows a card for you to approve. A turn that called an outside tool says on its checkpoint that its external side effects are not reversible, and that restoring the turn puts back Caotang's own changes only.
- **Restore to before this turn.** This takes the project back to where it was before that turn. It also takes back the edits you made since then, and the later changes the dialog lists. The dialog says so before it does it.
- **Activity.** The **Activity** tab lists every change, marked **You** or **Agent**, and a call to an outside tool carries an **MCP** badge. **Undo** takes one back.

## Skills

A skill is a set of instructions you write once and the agent follows when your request fits it: "draft in close third person, past tense, no adverbs in dialogue tags", or "fill synopses in three beats", or "use these slug-line conventions". The codex holds facts about your story; a skill holds how you want the agent to work. Choose **Skills** in the toolbar to open the panel.

- **New skill…** asks for a name (lower-case letters, digits and hyphens) and opens its instructions. The first lines, between two lines of dashes, give the skill its name and say when to use it in a sentence or two (the **description**, which is what the agent reads to decide). Everything after them is what the agent follows. The editor says at once if the text cannot be used, and **Save** waits until it can.
- **Import a folder…** and **Import a zip…** take skills someone else wrote. A skill is a folder of text files with its instructions file in it; a zip can hold one skill, or a folder of skills. A skill that is too large is refused, and the message names the limit: 50 skills in a project, 64 files in a skill, 256 KB for a file and 2 MB for a skill.
- **Turn on / Turn off** decides whether the agent may be told about a skill. **Delete** takes a skill out of the project, and **Undo** brings it back.

**The agent sees a skill only after you have approved it.** A skill is text the agent will follow, and a project someone shares with you may carry skills you have not read. **Read and approve…** shows everything in the skill as plain text, exactly as it is: the instructions and every other file. A character that cannot be seen on screen is shown as its code in brackets, such as ⟦U+200B⟧, and the review counts them, so a hidden instruction cannot slip through. A comment is shown as written. If the skill includes scripts, the review names them and says that Caotang reads the instructions and does not run them, and that other programs reading the same folder, such as Claude Code or Codex, may. **Approve this skill** is your decision. Change any file of the skill, in Caotang or in another program, and it needs your approval again; until then the agent is not told about it, and the agent panel says how many skills are waiting. Your approvals are kept in this browser and are not part of the project, a bundle or an export.

When a skill is approved and on, the agent is told its name and description. It loads the skill when your request fits, and the instructions guide that turn's drafts. A skill changes how the agent works and nothing else: every change that needs your approval still shows its card, whatever a skill says. A skill whose instructions you keep for yourself (`disable-model-invocation: true` in its first lines) is listed as **Only you use it**, and the agent is never told about it.

Skills are kept in the project, in the folder `.agents/skills/`, so a project folder, a `.caotang` bundle and this browser's copy all carry them, and other programs that read that folder use them too. The agent can suggest a skill in its answer, and it cannot create, change, import or turn on a skill; only you can.

## Export

Choose **Compile…** in the toolbar. Then choose a recipe, a format and what to export.

- **Recipe** picks a saved set of export settings. The settings are **Title page**, **Contents list** and **Author on the title page**; for the dialogue table, **Character limit for each line**; for the screenplay PDF, **Scene numbers** and **(MORE) and (CONT’D) where a speech crosses a page**; and for the contact sheet, **Paper size**. They apply to the whole manuscript, or to the one item you choose. To keep a set of settings, name it under **Save these settings as a new recipe** and choose **Save as recipe**.
- **What to export** is **The whole manuscript**, or **Only “…”** for the item you selected in the binder.
- Choose **Compile**. Undo removes the file the compile wrote. A compile that Caotang refuses is said inside the dialog, beside **Compile**, and no file is saved. The message clears when you choose another recipe or format.
- Empty documents are left out, and the status line says how many were skipped.
- Research is never included.
- A scene marked **Section** (its **Export style** in the inspector) prints its title as a heading above it, which a scene never does otherwise: `###` in Markdown, capitals in plain text, a second-level heading in Word and EPUB. In Word the contents field lists it under its chapter. The Markdown and EPUB contents lists stay the list of chapters. A file you exported before still has no scene titles, so an export made now differs from it for every scene you mark.

The formats come in three groups:

| Group | Format | What you get |
|---|---|---|
| Prose | Markdown (`.md`) | Plain Markdown, with a contents list after the title. |
| Prose | Plain text (`.txt`) | Chapter headings in capitals, with scenes set apart by a line. |
| Prose | Word (`.docx`) | Styled headings, and a contents field filled with the chapter headings. Word offers to update the field when the file opens. How Word and LibreOffice handle the field has not been tested. |
| Prose | EPUB (`.epub`) | A reading-system book, one file per chapter. |
| Media | Fountain (`.fountain`) | The screenplay as plain Fountain text, for Beat or Highland. |
| Media | Final Draft (`.fdx`) | The screenplay in Final Draft's XML. Not yet checked in Final Draft itself. |
| Media | Screenplay PDF (`.pdf`) | The screenplay on US Letter pages in Courier Prime, ready to print. See [The screenplay PDF](#the-screenplay-pdf). |
| Media | Ink story (`.ink.json`) | The dialogue compiled for a game engine that reads Ink. |
| Media | Dialogue table (`.csv`) | Each spoken line with its id, speaker, text and locale. A Yarn container gets a Yarn strings file. |
| Media | Shot list (`.csv`) | Each shot in order, with its size, angle, movement and duration. |
| Media | Dialogue table (`.xlsx`) | The dialogue table as a spreadsheet, with the same columns and rows as the `.csv`. |
| Media | Shot list (`.xlsx`) | The shot list as a spreadsheet, with the same columns and rows as the `.csv`. |
| Media | Storyboard contact sheet (`.pdf`) | Each shot as a card with its picture, number, camera details and action, on A4 or US Letter pages. |
| Media | Prompt pack (video) | The JSON, Markdown and CSV packs for one video model, in one zip. Choose the **Vendor template** it is written for; with none chosen the compile is refused and nothing is written. |
| Review | Coherence report (`.md` or `.json`) | The findings and the runs, for reading outside Caotang. |

The spreadsheets have one sheet each, with the column names in a bold first row that stays in view as you scroll. Shot numbers, durations and character limits are numbers, so a spreadsheet can sort and add them. Text is kept as text: a cell that starts with `=`, `+`, `-` or `@` is never run as a formula. A cell longer than 32,767 characters is cut, and the compile log says which. The spreadsheets are made in the browser, and nothing is sent anywhere.

The title page's date is the day you compile, in your own time zone, not the UTC day.

With **Prompt pack (video)**, choose the **Vendor template** the pack is written for. A pack recipe keeps that choice, and the compile writes the JSON, Markdown and CSV packs into one zip. The storyboard's **Prompt pack** tab still exports one file at a time.

**Export bundle** is not a compile. It is a full copy of the project, for backups. **Export as Markdown** in the Activity tab writes the activity log as a file.

## Settings

Choose **Settings** on the projects screen or in the toolbar. It has eight sections: Providers, Context, Agent, Writing, Coherence, MCP & tools, Appearance and Data.

- **Providers.** Choose **Add a provider**, then pick the provider in the list — its address and authentication are already set, and some providers ask for an extra field such as a region or a workspace id. Enter a name, a model (the field offers the provider's own model list), and the key. A provider whose API does not answer a browser page is marked **Desktop app or hosted only**. A model server running on this computer — **Ollama**, **LM Studio** or **llama.cpp (llama-server)** — is listed under **On this computer**; see below. For an endpoint of your own, choose the generic entry above that group: you type the base URL (ending in `/v1`) yourself, and can add extra request headers that are sealed with the key. **Save profile** checks the endpoint and lists its models. **Use this profile** makes it the one the agent calls. Keys stay in this browser, and are never written into a project. A server on this computer needs no key unless you set one on the server. You can add a price per 1,000 tokens, which lets Caotang show what a step costs. To remove a saved price, empty both price fields and save. The usage totals count requests by day, profile, model and task role. The request log lists each request's time, profile, attempt, outcome, status, the output cap it was sent with (thinking room included) and address. It does not store your manuscript or prompts. For a failed request it can keep a short excerpt, up to 300 characters, of the error the provider or the network returned, with your key removed. A provider's error can repeat part of what was sent, so check the request log before you share it.
- **Models on this computer.** Under **On this computer** the provider list has **Ollama**, **LM Studio** and **llama.cpp (llama-server)**. Pick one, check the server address (it starts as the usual one, such as `http://127.0.0.1:11434/v1`, and you can change the port), and enter the name of a model you have pulled or loaded. Caotang talks to these servers only at an address on this computer, over plain http, and refuses any other address with the reason; the line **Your text stays on this computer** shows while the address is one. The server has to let the page call it. Ollama needs `OLLAMA_ORIGINS` set to the address Caotang is served from (for caotang.app, `OLLAMA_ORIGINS=https://caotang.app`) and a restart. LM Studio needs **Enable CORS** in its server settings. llama-server answers pages by default, but a server started with `--tools` or `--agent` needs `--cors-origins`. If the browser is blocked, the error names the setting. The first time, Chrome and Edge ask whether the site may connect to apps on your device; choose Allow. Until the server says otherwise, Caotang assumes a small context window (4,096 tokens) and no native tools or image input, so raise the window on the server: `OLLAMA_CONTEXT_LENGTH` for Ollama, the context length when you load the model in LM Studio, `-c` for llama-server. A model that takes time to load is given up to three minutes before its first words.
- **Roles.** Below the profiles, **Chat**, **Drafting** and **Background** each name the profile, model and thinking level their calls run on. Chat is the agent panel, including the drafts a plan writes there; Drafting is the prompt pack's generations; Background is checks, encoding work and the plans you send to run in the background. Drafting and Background follow Chat until you pin them to a profile of their own. A thinking level is offered only when the chosen model supports thinking, and only the levels it takes. Off is not offered where the model always thinks. On a model that takes a thinking budget, a higher level raises the output cap for that call so the answer still has room, and a step's cost estimate adds the thinking and says "including thinking".
- **Context.** How much the agent may send the model in one request: the whole prompt, and the codex entries, the story so far and the focus document. Leave a field empty for the default. A change applies from the agent's next request.
- **Agent.** **Load every tool on every request**, off by default. Turn it on for a model that does not find tools with the agent's search. A change applies from the agent's next request.
- **Writing.** The daily target in words (0 for none), and the pause after you stop typing before Caotang saves (100 to 5,000 ms). A new pause applies to the projects you open after you save.
- **Coherence.** The quick checks the Findings scan runs, the scope the Findings tab starts with, and the most findings one model review may add. **Save coherence settings** saves them.
- **MCP & tools.** External tool servers are off until you turn on **Use external tool servers**. While it is off, no server is contacted. Then choose **Add server**, and give it a name and an address: https, or http for a server on your own computer. Add its bearer token if the server needs one. The token is kept in this browser, as your provider keys are. **Connect** lists the server's tools. Read the review before you approve it: each tool's description is shown in full, and a list that has changed since your last approval waits for your approval again. The **On** checkbox in a tool's row turns that tool on or off. **Enable** or **Disable** on a server card turns the whole server on or off. **Trusted for reads** lets the read-only tools run without asking, and it is offered only after a review. **Check again** lists the tools once more, and **Remove** forgets the server. **Show the list** and **Import a list** move the server list as text, without tokens, tool approvals or trust. A tool whose name has a character that a model's tool names may not hold, such as a dot, is shown to the agent under a shorter alias. The server still receives its own name. A server can also list prompts and resource templates. They are shown in the same review, in full, with whether you have approved them, and approving the list approves them too; one that changes afterwards is shown again and waits for you, while the server's tools stay approved. If the server's list of resources or prompts cannot be read, its card says so and the tools are not affected. This build only lists them: it does not yet attach a resource to a request or run a prompt, and the agent cannot do either.
- **Appearance.** Light or dark. Until you choose, Caotang follows your system setting.
- **Data.** The storage location, which is this browser, what the browser says about its storage, and the checkpoint limits: **Checkpoints kept per project** (100 by default) and **Days a checkpoint is kept** (30 by default). Choose **Save the limits** to keep your change. With a project open, **Trim to the limits now** applies them at once.

## Keyboard

On a Mac, Cmd takes the place of Ctrl. The element chords are the one exception: they use Cmd+Alt, because Cmd+Shift+3 and Cmd+Shift+4 take screenshots.

| Key | What it does |
|---|---|
| Ctrl+N | New document. |
| Ctrl+Z | Undo your typing in the editor. Elsewhere, undo the last change Caotang made. |
| Ctrl+Shift+F | Focus mode, which hides the binder and the inspector. |
| Ctrl+Alt+F | Move to the binder's filter. |
| Ctrl+Enter | Open the selected item in the editor. |
| Ctrl+E | On a screenplay's Source tab, open the element menu for the caret's line. |
| Ctrl+Shift+1 to 9 (Cmd+Alt+1 to 9 on a Mac) | On a screenplay's Source tab, make the caret's line the 1st to 9th element of the element menu. |
| F2 | Rename the selected item in the binder. |
| Delete | Delete the selected item in the binder. It asks first. |
| Arrow keys | Move the selection in the binder. |
| Alt+Up, Alt+Down | Move the selected item among its neighbours in the binder, or earlier and later on the corkboard. |
| Alt+Left, Alt+Right | In the binder, move the item out of its folder, or into the folder above. |
| Esc | Close a menu or a dialog. A menu returns focus to the control that opened it. In the agent panel, with the Intent box empty, stop the running turn. |
| Enter, in the agent's Intent box | Send the message, or queue it as the next turn while the agent works. |
| Ctrl+Enter, in the agent's Intent box | Send the message to the running turn as a note. |

The tabs on the left (**Binder**, **Codex**, **Activity** and **Findings**) and the **Editor** and **Corkboard** buttons take the arrow keys, Home and End. In a menu, the arrow keys move between items, and Enter or Space chooses one.

## Bringing existing writing in through the MCP server

If your writing is somewhere else, such as in notes, a wiki or an old draft, the MCP server can bring it into a Caotang project. Two tools do that:

- The import tool that adds one document places it under a folder. It takes a title, a body in Markdown, and optionally a synopsis, keywords, a status and a label. The body is stored exactly as you give it. A body the project file cannot keep unchanged is refused, and nothing is created.
- The import tool that adds codex entries adds up to 20 entries in one call. Each entry is attached to a document whose text names it. A name that already exists is refused, so nothing is merged. Imported entries show as **Imported** in the codex, not as **Drafted by the agent**.

Each call asks you to confirm in your AI host. Decline it, and nothing is written.

A coherence scan run from your host on a server started with `--allow-writes` is saved to the folder, and its findings and run show in the **Findings** tab after the folder is opened in Caotang again.

If the folder's `caotang.json` is damaged, the server still starts, and says in your host that the project could not be opened. Ask the host to run `project.recover`: it shows which earlier copy of `caotang.json` would be restored, or that the project would be rebuilt from its documents, which loses the folder structure and the status and label terms. On a server started with `--allow-writes`, `project.recoverApply` applies it after you accept the host's dialog, which names the file it restores from and the copy of the damaged file it keeps (`caotang.json.corrupt-` and a time). A rebuild is asked for separately. Nothing is written if another program changed the folder in the meantime. Afterwards restart the server, or reconnect the host, to open the recovered project. A folder from another app or a newer Caotang is refused, as it is in the app. The server holds the folder's lock until it stops, so the app asks before it saves there.

To bring writing in:

1. Make a project folder with the server, and allow writes:

   ```sh
   node packages/mcp-server/dist/caotang-mcp.mjs serve --project ~/Writing/my-world --create "My World" --allow-writes
   ```

   `--create` only makes a project in a folder that holds no project files. It is refused for a folder with any project file, including the backup copies of the manifest (`caotang.json.*`), so it cannot take them over. A folder that already holds a project should be opened in Caotang first.

2. Connect your host. The [README](../README.md#caotang-as-an-mcp-server) shows how. A host on a 2025 protocol revision can confirm writes over HTTP when it declares elicitation and keeps the session the server gives it. If it cannot, connect it over `--stdio`, or install the `.mcpb` bundle, which runs over stdio.
3. Ask the host to import each document first, then the codex entries that name it. An entry is refused if its name does not appear in the document it is attached to.
4. Stop the server.
5. In Caotang, choose **Open a folder…** on the projects screen. This needs Chrome or Edge. The project opens in your browser, and **Save to folder** writes it back to the same folder.

Two limits to know:

- After you open the folder in Caotang, Caotang's **Undo** does not reach the imports. To remove one, delete it in the binder.
- Confirmations do not survive a restart of the server. A call whose confirmation was lost is refused, and nothing is written.

With writes allowed, an outside tool can also compile the manuscript, one item, or a saved recipe, in any format the Export dialog offers, EPUB included. The host asks you to confirm each compile first, as it does for any other change.

## Installing the MCP bundle

The MCP server also comes as a `.mcpb` file that a host such as Claude Desktop can install. Build it as the [README](../README.md#caotang-as-an-mcp-server) says, or take it from the latest release. In the host:

1. Drag the file onto the host, or open it with the host.
2. In the dialog, choose a **Project folder** that already holds a Caotang project.
3. Leave **Allow changes** off to let the assistant read the project only. Turn it on to let it change the project; some changes still ask you to confirm them first.
4. If the host warns that the bundle is not signed and offers **Install Anyway**, that is expected. The host cannot name a publisher for it, because the signing tool today produces bundles that hosts refuse. The code is open, and you can build the same file from source.

The server runs on your computer and opens no network port. Uninstalling it leaves your project folder untouched. The dialog's wording differs between hosts and versions. The bundle is not signed, and it has not been tested in a real host yet.

## Scripting Caotang

A developer can run the agent against a project folder from a Node script, a command line or CI, with the `@caotang/sdk` package. There are no cards to click there, so the script chooses a policy that answers them: refuse every change (the default), approve every card, or its own function. Nothing is saved unless the script asks for it, and it can read the diff first. Its README is [packages/sdk/README.md](../packages/sdk/README.md). Keep the app and a script off the same folder at once: the script leaves the same lock file the MCP server does, and the app asks before it saves over it.

## When something seems wrong

- **The agent says it cannot do that.** The built-in demo provider answers only three requests. Add a provider in Settings › Providers.
- **Approve is greyed out.** The card waits until its draft has been shown in its scene. Open that scene.
- **Apply is greyed out.** The draft preview waits until the draft has been shown in its scene. Open that scene.
- **Review with agent says it needs a provider.** The model review needs a provider. Connect one in Settings › Providers.
- **The project is open in another tab.** Switch to that tab, or close it, then open the project again.
- **This tab cannot save.** Another tab has newer text for this project. Export a backup, then reload this tab. Caotang keeps the words in this browser when it can, and offers them back under **Kept from a stopped tab** in the binder footer.
- **Caotang was updated in another tab.** A newer Caotang opened in another tab and updated this browser's storage, so this tab cannot save. Export a backup to keep the words on screen, then reload this tab to carry on with the updated Caotang.
- **Caotang says a folder's `caotang.json` was removed.** Another program removed it after Caotang last loaded or saved the folder, so nothing was written. Saving writes it back from this tab.
- **Caotang will not open a project file.** The file names another app, or a format newer than this version of Caotang reads. Nothing is written. A file in a newer format opens in a newer Caotang. A file that names another app is not a Caotang project.
- **There is no Save to folder or Open a folder button.** Those need Chrome or Edge. Bundles work in any browser.
- **A scene is missing from the export.** Empty scenes are left out. The status line names how many.
- **Compile says what stopped it.** A dialogue line with no id, or a selection with no scene, is named in the dialog.
- **The Ink does not compile.** The dialogue view lists the errors. Fix them in the Ink text.
- **A passage is refused for script coverage.** It appears more than once in the text, and the message says how many places. Select more words around the one you mean.
- **The browser warns that it has not promised to keep your words.** Export a bundle now, and again from time to time.
- **A card is hidden under the agent panel.** Close the panel to reach it.

## What is not in this build yet

- **Exports.** The screenplay PDF is US Letter only; there is no A4 page and no choice of font.
- **Contact sheet pictures and characters.** The contact sheet does not draw WebP pictures; their cards show the caption. Characters that none of its fonts has, such as Tamil, print as `?`. The compile log names them. Emoji print in black and white, and skin tones as the plain figure. Chinese, Japanese and Korean text has no bold, and Han characters take their Simplified Chinese forms.
- **Final Draft files.** Import and export of `.fdx` files have not been checked against files that Final Draft wrote or opened. The scene numbers and page headers that Caotang writes are not yet confirmed to show in Final Draft.
- **Word contents.** How Word and LibreOffice handle the contents field in a `.docx` file has not been tested.
- **The Pages view.** You cannot type on the Pages view of a screenplay yet; a line opens its element in the Source tab. It draws a dual-dialogue pair side by side, as the PDF does, but it closes up the blank lines and is not the page's exact height.
- **Undo and reloads.** The toolbar's Undo and the Undo in Activity last for the open tab; checkpoints survive a reload. Undo on a screenplay's Source tab and in Ink text is the browser's own.
- **Local models, checked.** The three local model servers have been tried against test servers that imitate their browser settings, not against the real Ollama, LM Studio and llama-server. Firefox has not been tried, and Safari is not verified. A server on another computer on your network is not supported: plain http is allowed only to this computer.
- **What a local server reports.** Caotang does not yet ask a local server about the model it runs, so it assumes a small context window and no native tools or images.
- **The MCP bundle.** The `.mcpb` bundle is not signed, so a host asks you to confirm the install, and it has not been tested in a real host.
- **Skill scripts and files.** Skills that include scripts: Caotang uses their instructions and does not run the scripts. The agent cannot read the other files kept with a skill, a skill's list of allowed tools does not limit the agent, and there are no skills shared across projects and no way to run a skill by name. Only the project's `.agents/skills` folder is read.
- **Background tasks.** A task is drafted only while the project is open in this tab: close the tab and it stops, and **Resume** finishes it when you open the project again. A coherence review cannot be queued yet; it runs now. A background call waits for the agent to be free, but one already sent still counts against a rate-limited key.
- **The desktop app.** Caotang runs in the browser. A desktop wrapper is not in this build.
