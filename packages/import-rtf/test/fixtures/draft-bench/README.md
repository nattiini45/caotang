# Scrivener 3 fixtures from obsidian-draft-bench

`content/<UUID>.rtf` are the `Files/Data/<UUID>/content.rtf` files, and `search.indexes` is `Files/search.indexes`, of the
`ScrivenerTesting.scriv` test project in [banisterious/obsidian-draft-bench](https://github.com/banisterious/obsidian-draft-bench)
(`tests/fixtures/scrivener/`, fetched 2026-11-01), under the MIT licence in `LICENSE`. They were written by Scrivener 3 for
Windows (Sitka and Corbel fonts, `\uc1`, `\loch\hich\dbch`, Scrivener's `<$Scr_Ps::n>` style markers, a `scrivcmt://` linked
comment, lists and a title-page table).

`search.indexes` is Scrivener's own plain-text extraction of every document, so it is the reference the reader's text and word
counts are checked against (`test/scrivener-fixtures.test.ts`).
