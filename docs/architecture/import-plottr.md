# The Plottr outline import 🧭

> Status: **built** (#290). `packages/import-plottr` (`@caotang/import-plottr`) reads Plottr `.pltr` JSON in the import preview's `'self'` Worker, and **Import Plottr…** opens the shared preview. Epic: #263.

## 1. Shape

A `.pltr` file is untrusted JSON and is parsed, never executed. The reader accepts the older flat `beats` array and the current per-book `children`/`index` shape. A series file with several books gets a Book choice; cards, beats and plotlines are read for the chosen book. Series-level plotlines outside that book are named as losses.

Cards in one beat merge across plotlines into one chronology. Beats become chapter folders; nested beats remain nested folders; cards become scene documents. Plottr is an outliner, not a manuscript: a scene imports with empty prose. Its card description becomes the synopsis up to Caotang's synopsis limit, and overflow becomes body text. A card with no beat goes into **Unsorted cards**.

Plotlines become Caotang thread declarations on their scenes. The format carries no payoff scene, so the last scene in reading order is the fallback payoff; a one-scene import names the loss instead of pointing a thread at itself. Characters and places become codex entries: the description and the start of the notes form the entry description, tags and category become keywords, and notes plus every custom attribute stay on the entry's research page. Plottr notes become Research documents, and a note linked to a person or place becomes an additional attachment of that codex entry. Card tags become scene keywords; POV, characters and places become scene declarations. Embedded data-URL images are decoded locally, sniffed by magic bytes, capped, and used in scene or research text; a mislabelled type is corrected. Nothing is fetched.

## 2. Preview and commit

The shared preview shows the proposed tree, counts, losses and injection scan before anything is written. The import is one `binder.importTree` commit for nodes, codex entries, pages, pictures and scene metadata, and one Undo takes it back. The file is read once in the Worker; the 25 MB file cap, per-image and total-image caps, and item cap refuse or report excess before allocation where possible.

## 3. Not built

Plottr templates, colours, UI state, custom hierarchy names and unknown newer top-level fields are not imported; unknown fields are counted in the losses. Plottr timeline dates are not calendar dates, so no day offsets are invented. Embedded images are attached as codex visual references and kept in the imported text of the scene or research page.

## 4. Tests

The unit fixtures are MIT-licensed Plottr files copied from Kindling: two small old-shape files and the large Hamlet current-shape file. Tests cover both beat shapes, rich-text conversion, books, plotlines, people, places, notes, tags, malformed input and images; shared-preview tests cover hierarchy, synopsis-only scenes, threads, codex rows, research notes, pictures and the single commit shape.
