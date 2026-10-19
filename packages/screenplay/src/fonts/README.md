# Fonts of the screenplay PDF

| File | Font | Source | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `courier-prime-regular.ts` | Courier Prime Regular 3.018, as base64 | google/fonts, `ofl/courierprime/CourierPrime-Regular.ttf` (71188 bytes) | `72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af` (the TTF) | OFL 1.1, `OFL.txt` |
| `NotoEmoji-Regular.ttf` | Noto Emoji Regular 3.002 (monochrome), the static wght=400 instance | Derived from https://github.com/google/fonts/raw/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf (1982596 bytes, commit `b979dba422e445492b0eb9951ac52ee0b4d648c3`, "Update Noto Emoji to the 3.002 release"; SHA-256 of that variable font `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`), see below (886628 bytes) | `c170291ac225588dc58595df2ad1e3a91b4fddab78f3f5fcdbe0da0feb1f14d6` | OFL 1.1, `OFL-NotoEmoji.txt` |
| `NotoSansMonoCJKsc-Regular.otf` | Noto Sans Mono CJK SC Regular 2.004 | https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Regular.otf (16393784 bytes, tag `Sans2.004`, commit 523d033d6cb47f4a80c58a35753646f5c3608a78) | `ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7` | OFL 1.1, `OFL-NotoSansMonoCJK.txt` |

Courier Prime is the screenplay font. Noto Sans Mono CJK SC is the fallback for every character WinAnsi cannot encode: Hanzi, kana, Hangul and more. Noto Emoji is the fallback after it, for emoji. Courier Prime and Noto Sans Mono CJK SC are byte for byte as published. `test/pdf-font.test.ts`, `test/pdf-cjk.test.ts` and `test/pdf-emoji.test.ts` check the files.

## Noto Emoji

Noto Emoji is Google's monochrome emoji font, the black-and-white sibling of Noto Color Emoji. The project lives at https://github.com/googlefonts/noto-emoji, but that repository ships only the colour fonts today (its last monochrome file, `fonts/NotoEmoji-Regular.ttf`, is version 1.05 from 2020, with 887 code points and no ZWJ sequences). The current monochrome release, 3.002, is published as a variable font (wght 300–700, TrueType outlines) in google/fonts, pinned above by commit. Its license file is `ofl/notoemoji/OFL.txt` at the same commit, copied here as `OFL-NotoEmoji.txt`; it names no Reserved Font Name.

The file here is the static Regular instance of that variable font, made with fontTools 4.61.1:

```sh
python3 -m fontTools.varLib.instancer 'NotoEmoji[wght].ttf' wght=400 --update-name-table -o NotoEmoji-Regular.ttf
```

The run is deterministic: it gives the SHA-256 in the table every time. The instance has TrueType (`glyf`) outlines and keeps the font's `GSUB` (`ccmp` ligatures), so fontkit's layout turns a ZWJ sequence, a flag, a keycap or a tag sequence into one glyph. Its `name` table says Noto Emoji Regular, version 3.002, PostScript name `NotoEmoji-Regular`.

The font supports Unicode Emoji 15.1. Every fully-qualified emoji in `test/fixtures/emoji-test-15.1.txt` (Unicode's `emoji-test.txt` for 15.1, byte for byte from https://unicode.org/Public/emoji/15.1/emoji-test.txt, SHA-256 `d876ee249aa28eaa76cfa6dfaa702847a8d13b062aa488d465d0395ee8137ed9`, under the Unicode License v3) prints, and the test checks it. The font has no skin tones: a toned sequence prints as its untoned glyph. Ninety 15.1 sequences, the people "facing right" with a gender (🚶‍♀️‍➡️), have no glyph of their own and print as their first emoji (🚶).

`noto-emoji-coverage.ts` lists what the font prints: its code points, the sequences it lays out as one glyph, and the few that need their skin tones to. It is generated from the font and the emoji list: run `node packages/screenplay/scripts/emoji-coverage.mjs` after either changes.

`noto-cjk-coverage.ts` lists the code points the Noto font maps. It is generated from the font: run `node packages/screenplay/scripts/cjk-coverage.mjs` after the font changes.

The Noto Sans Mono CJK SC file is loaded only by `src/cjk-font.ts`, and the Noto Emoji file only by `src/emoji-font.ts`, each through a dynamic import, and only for a script that needs it.
