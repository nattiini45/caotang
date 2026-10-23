/**
 * The glyph ids the vendored CJK font (vendor/noto-sans-cjk, Noto Sans Mono CJK SC 2.004 built with `locl`) draws a Han
 * character with in each language's forms, and how they relate to the upstream font's. The upstream OTF has the same forms at
 * other ids (a build drops the glyphs no character reaches, so the ids move): in it 直 is 27874 in SC and 27873 in JP and
 * KR, 27875 in HK; `delta` is each form's id less the SC one, the same in both files because the forms sit side by side. The
 * ids here are HarfBuzz's too (han-glyphs.test.ts shapes them).
 */

/** The languages whose forms differ from the font's own, and a tag of each that `hanLocaleTag` maps to a language system. */
export const HAN_LANGUAGES = [
  { language: 'ja', tag: 'JAN ' },
  { language: 'zh-Hant', tag: 'ZHT ' },
  { language: 'ko', tag: 'KOR ' },
  { language: 'zh-HK', tag: 'ZHH ' },
] as const;

export type HanForms = { readonly sc: number } & { readonly [language in (typeof HAN_LANGUAGES)[number]['language']]: number };

/** Glyph ids by character: the cmap (Simplified Chinese) glyph, then the forms of ja, zh-Hant (zh-TW, zh-MO), ko and zh-HK. */
export const HAN_FORMS: Readonly<Record<string, HanForms>> = {
  直: { sc: 27755, ja: 27754, 'zh-Hant': 27755, ko: 27754, 'zh-HK': 27756 },
  骨: { sc: 44997, ja: 44996, 'zh-Hant': 44998, ko: 44996, 'zh-HK': 44996 },
  今: { sc: 9668, ja: 9667, 'zh-Hant': 9669, ko: 9667, 'zh-HK': 9669 },
  說: { sc: 37759, ja: 37758, 'zh-Hant': 37760, ko: 37758, 'zh-HK': 37759 },
  次: { sc: 22382, ja: 22381, 'zh-Hant': 22383, ko: 61896, 'zh-HK': 22382 },
};

/** Fullwidth punctuation: 。 is bottom-left in SC, JP and KR, and centred in TC and HK. */
export const HAN_PUNCTUATION: HanForms = { sc: 1296, ja: 1296, 'zh-Hant': 62148, ko: 1296, 'zh-HK': 62148 };

/** Each form's id less the cmap one, from the table in the issue (upstream ids). */
export const HAN_DELTAS: Readonly<Record<string, Omit<HanForms, 'sc'>>> = {
  直: { ja: -1, 'zh-Hant': 0, ko: -1, 'zh-HK': 1 },
  骨: { ja: -1, 'zh-Hant': 1, ko: -1, 'zh-HK': -1 },
  今: { ja: -1, 'zh-Hant': 1, ko: -1, 'zh-HK': 1 },
  說: { ja: -1, 'zh-Hant': 1, ko: -1, 'zh-HK': 0 },
};
