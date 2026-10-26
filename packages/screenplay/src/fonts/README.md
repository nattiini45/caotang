# Fonts of the screenplay PDF

| File | Font | Source | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `courier-prime-regular.ts` | Courier Prime Regular 3.018, as base64 | google/fonts, `ofl/courierprime/CourierPrime-Regular.ttf` (71188 bytes) | `72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af` (the TTF) | OFL 1.1, `OFL.txt` |
| `cousine-regular.ts` | Cousine Regular 1.241, as base64 | google/fonts, `ofl/cousine/Cousine-Regular.ttf` (296856 bytes) | `1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe` (the TTF) | OFL 1.1, `OFL-Cousine.txt` |

Courier Prime is the screenplay font. Cousine, metric-compatible with Courier New, is the recipe's other embedded choice (`scriptFont`); the third, `courier`, embeds nothing and names the base-14 Courier. `test/pdf-font.test.ts` checks both files and `cousine-metrics.ts` against their tables.

A font offered here must be monospaced at 600 units to the em (the layout's 7.2 points a character, so no line breaks differently) and have TrueType (`glyf`) outlines, because it is embedded whole and `@pdf-lib/fontkit` writes broken CFF subsets. `test/pdf-paper.test.ts` checks that every character the writer accepts has a glyph in it.

Every character WinAnsi cannot encode prints in a fallback font, and neither fallback ships in this package. Both PDFs (this one and the storyboard contact sheet) share one CJK font and one emoji font:

- Noto Sans Mono CJK SC 2.004, for Hanzi, kana, Hangul and more: `vendor/noto-sans-cjk` (`@caotang/font-noto-cjk`), a TrueType WOFF built from the upstream OTF (10,692,940 bytes), and a common file cut from it to the characters of everyday use (1,956,568 bytes);
- Noto Emoji 3.006, for emoji (Unicode Emoji 17.0): `vendor/noto-emoji` (`@caotang/font-noto-emoji`), a static TrueType WOFF (579,236 bytes), and a common file of the single-code-point emoji and the keycaps (298,992 bytes).

A script whose characters in a font are all in its common file reads only that file; one character outside it reads the full font, and the PDF holds the same glyphs either way (`@caotang/pdf-fonts/common`).

Their sources, checksums and builds are in those packages' READMEs. The host passes a loader for each (the app fetches the files from its own origin, Node reads them from the packages: `@caotang/pdf-fonts/node-loader`), and `src/cjk-font.ts` and `src/emoji-font.ts` cut the subsets through `@caotang/pdf-fonts`, each through a dynamic import and only for a script that needs it. The coverage tables the layout reads before a font loads (`packages/pdf-fonts/src/coverage`) are generated from those files by `packages/pdf-fonts/scripts`.
