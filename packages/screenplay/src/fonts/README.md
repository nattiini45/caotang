# Fonts of the screenplay PDF

| File | Font | Source | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `courier-prime-regular.ts` | Courier Prime Regular 3.018, as base64 | google/fonts, `ofl/courierprime/CourierPrime-Regular.ttf` (71188 bytes) | `72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af` (the TTF) | OFL 1.1, `OFL.txt` |

Courier Prime is the screenplay font. `test/pdf-font.test.ts` checks the file.

Every character WinAnsi cannot encode prints in a fallback font, and neither fallback ships in this package. Both PDFs (this one and the storyboard contact sheet) share one CJK font and one emoji font:

- Noto Sans Mono CJK SC 2.004, for Hanzi, kana, Hangul and more: `vendor/noto-sans-cjk` (`@caotang/font-noto-cjk`), a TrueType WOFF built from the upstream OTF;
- Noto Emoji 3.006, for emoji (Unicode Emoji 17.0): `vendor/noto-emoji` (`@caotang/font-noto-emoji`), a static TrueType WOFF.

Their sources, checksums and builds are in those packages' READMEs. The host passes a loader for each (the app fetches the files from its own origin, Node reads them from the packages: `@caotang/pdf-fonts/node-loader`), and `src/cjk-font.ts` and `src/emoji-font.ts` cut the subsets through `@caotang/pdf-fonts`, each through a dynamic import and only for a script that needs it. The coverage tables the layout reads before a font loads (`packages/pdf-fonts/src/coverage`) are generated from those files by `packages/pdf-fonts/scripts`.
