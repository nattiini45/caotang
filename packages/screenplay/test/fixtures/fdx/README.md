# FDX test fixtures

- `TestFDX-FD.fdx` is a file Final Draft wrote, copied unchanged from
  [wildwinter/screenplay-tools](https://github.com/wildwinter/screenplay-tools/blob/main/tests/TestFDX-FD.fdx)
  (commit `e19fdefafb9c2a80656d44603a8f4564eca8ca16`). It is MIT-licensed, copyright (c) 2024 Ian Thomas; the license
  text is in `LICENSE-screenplay-tools.txt`. It is a test input only and does not ship in any Caotang build.

The other FDX cases in `fdx-nested.test.ts` are hand-written in the shapes Final Draft and other FDX writers use
(a scene summary, an inline script note, the `ScriptNotes` list, a wrapped dual-dialogue pair, fractional lengths,
run styles). `rsdoiel/fdx`'s sample files are AGPL-3.0, so they are not copied here.

Issue #265 adds three hand-written files, written for this repo in the shapes Final Draft documents and other writers use:

- `outline-fd13.fdx`: what **Send Outline to Script** writes (`Outline 1` to `Outline 4`, `Summary`, `Note`), with scene
  titles and colours in `SceneProperties`, a `Lyrics` paragraph and SmartType lists.
- `tv-acts.fdx`: a TV-template script with `Cold Opening`, `New Act`, `End of Act` and `Cast List` paragraphs, a `<Cast>`
  and `<CharacterHighlighting>`.
- `production.fdx`: revision marks (`RevisionID` on runs and the `<Revisions>` sets), `<LockedPages>`, `<TagData>`
  definitions and a tagged run, Beat Board items, an `<AltCollection>` entry and an arc beat with text. The inner shape of
  the Beat Board items and the alternate dialogue is a guess: `TestFDX-FD.fdx` holds both elements empty, and no public
  file showing their content was found. The importer counts their child elements, whatever they are named.

None of these is a file Final Draft wrote.
