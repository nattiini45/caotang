import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * Modern's tokens and materials (modern-interface.md §5.1, §5.3, §5.5, §9.2–§9.4, §15.1), read from tokens/modern.css as written:
 *
 * - the light, system-dark and chosen-dark blocks define the same tokens, the dark two with the same values, and every token a Modern
 *   value names resolves over Classic's (tokens/classic.css);
 * - the radii are concentric (inner = outer − padding) and the motion tokens have the spec's values, all zero under reduced motion but
 *   the 120 ms fade;
 * - every transparency fallback (the system's, the Appearance switch, no backdrop-filter) makes every material opaque and unblurred;
 * - **contrast on glass, computed** (§9.3, D13; axe cannot see through backdrop-filter): Modern's text over the scrim and over thick
 *   glass, composited over every colour the wallpaper draws (each taken as opaque, which is the worst case of any blend or blur of
 *   them), light and dark, meets 4.5:1; the text glow is not counted. The same holds on the frost and the paper, and in the solid
 *   surfaces the fallbacks put in their place. The two-tone focus ring meets 3:1 on every one of them.
 */

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const MODERN = read('../../apps/desktop/src/tokens/modern.css');
const CLASSIC = read('../../apps/desktop/src/tokens/classic.css');
const WALLPAPER = {
  light: read('../../apps/desktop/src/components/shell/modern/wallpaper-light.svg'),
  dark: read('../../apps/desktop/src/components/shell/modern/wallpaper-dark.svg'),
} as const;

/** The body of the first rule whose selector text is `marker`, from its opening brace to the matching close. */
function bodyOf(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no rule "${marker}"`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let at = open; at < css.length; at += 1) {
    if (css[at] === '{') depth += 1;
    if (css[at] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, at);
    }
  }
  throw new Error(`rule "${marker}" is not closed`);
}

/** The custom properties a block declares (its nested blocks too), comments left out. */
function declared(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

const PREFIX = ":root[data-shell='modern']";
const base = declared(bodyOf(MODERN, `\n${PREFIX} {`));
const light = declared(bodyOf(MODERN, `${PREFIX}:not([data-theme='dark']) {`));
const systemDark = declared(bodyOf(MODERN, `${PREFIX}:not([data-theme='light']) {`));
const chosenDark = declared(bodyOf(MODERN, `${PREFIX}[data-theme='dark'] {`));
const classicLight = declared(bodyOf(CLASSIC, '\n:root {'));
const classicDark = new Map([...classicLight, ...declared(bodyOf(CLASSIC, ":root[data-theme='dark'] {"))]);

const SCHEMES = {
  light: new Map([...classicLight, ...base, ...light]),
  dark: new Map([...classicDark, ...base, ...chosenDark]),
} as const;
type Scheme = keyof typeof SCHEMES;

/** A token's value with every var() replaced, in a scheme. */
function resolve(scheme: Scheme, name: string, seen: readonly string[] = []): string {
  const value = SCHEMES[scheme].get(name);
  if (value === undefined) throw new Error(`${scheme}: ${name} is not defined`);
  if (seen.includes(name)) throw new Error(`${scheme}: ${name} refers to itself`);
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_all, inner: string) => resolve(scheme, inner, [...seen, name]));
}

// ---- Colour arithmetic (WCAG 2.2 relative luminance; compositing in sRGB, as browsers blend). ----

type Rgb = readonly [number, number, number];
interface Rgba {
  readonly rgb: Rgb;
  readonly alpha: number;
}

function parseColour(text: string): Rgba {
  const value = text.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    return { rgb: [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as unknown as Rgb, alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]*)\)$/i.exec(value);
  if (rgba !== null) {
    const parts = (rgba[1] ?? '').split(',').map((part) => Number.parseFloat(part));
    return { rgb: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], alpha: parts[3] ?? 1 };
  }
  throw new Error(`not a colour: ${text}`);
}

function over(top: Rgba, below: Rgb): Rgb {
  return [0, 1, 2].map((at) => (top.rgb[at] ?? 0) * top.alpha + (below[at] ?? 0) * (1 - top.alpha)) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every colour a wallpaper draws: its gradient stops, fills and strokes. */
function wallpaperColours(scheme: Scheme): Rgb[] {
  const found = new Set([...WALLPAPER[scheme].matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase()));
  return [...found].map((hex) => parseColour(hex).rgb);
}

const colour = (scheme: Scheme, name: string): Rgba => parseColour(resolve(scheme, name));
const opaque = (scheme: Scheme, name: string): Rgb => {
  const value = colour(scheme, name);
  expect(value.alpha, `${scheme} ${name} is opaque`).toBe(1);
  return value.rgb;
};

/** The surfaces text can sit on in Modern, each as the colours it can show (glass over every wallpaper colour). */
function surfaces(scheme: Scheme): Record<string, Rgb[]> {
  const wall = wallpaperColours(scheme);
  const glass = colour(scheme, '--m-glass');
  const scrim = colour(scheme, '--m-scrim');
  const thick = colour(scheme, '--m-thick');
  const frost = colour(scheme, '--m-frost');
  return {
    'scrim on glass': wall.map((w) => over(scrim, over(glass, w))),
    'thick glass': wall.map((w) => over(thick, w)),
    frost: wall.map((w) => over(frost, w)),
    paper: [opaque(scheme, '--surface-page')],
    'solid (reduced transparency)': [opaque(scheme, '--m-solid')],
  };
}

const TEXT_ON_GLASS = '--on-glass';
const SCHEME_TOKENS = [...light.keys()];

test('the light and both dark blocks define the same tokens, the dark two with the same values, and none sets a material', () => {
  expect([...systemDark.keys()].sort()).toEqual([...light.keys()].sort());
  expect([...systemDark].sort()).toEqual([...chosenDark].sort());
  for (const name of SCHEME_TOKENS) expect(name.startsWith('--mat-'), `${name} is a primitive or a colour, not a material`).toBe(false);
});

test('every Modern token resolves in light and dark, over Classic’s', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const name of [...base.keys(), ...SCHEME_TOKENS]) expect(() => resolve(scheme, name), `${scheme} ${name}`).not.toThrow();
  }
});

test('the radii are concentric, as §5.5 has them', () => {
  const px = (name: string): number => Number.parseFloat(resolve('light', name));
  expect(px('--radius-page')).toBe(36);
  expect(px('--radius-ornament') - px('--ornament-pad')).toBe(px('--radius-control'));
  expect([px('--radius-ornament'), px('--radius-control')]).toEqual([30, 24]);
  expect(px('--radius-sheet') - px('--sheet-pad')).toBe(px('--radius-inner'));
  expect([px('--radius-sheet'), px('--radius-inner')]).toEqual([32, 20]);
  expect(px('--target-min')).toBe(44);
});

test('motion has the spec’s values, and reduced motion zeroes every duration but the fade', () => {
  expect([base.get('--dur-1'), base.get('--dur-2'), base.get('--dur-3'), base.get('--dur-fade')]).toEqual(['120ms', '240ms', '520ms', '120ms']);
  expect(base.get('--ease-spring')).toBe('cubic-bezier(0.3, 1.22, 0.42, 1)');
  expect(base.get('--ease-standard')).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
  for (const block of [bodyOf(MODERN, '@media (prefers-reduced-motion: reduce)'), bodyOf(MODERN, `${PREFIX}[data-motion='reduced'] {`)]) {
    const tokens = declared(block);
    expect([tokens.get('--dur-1'), tokens.get('--dur-2'), tokens.get('--dur-3')]).toEqual(['0s', '0s', '0s']);
    expect(tokens.has('--dur-fade')).toBe(false);
  }
});

test('every transparency fallback makes every material opaque, unblurred, without rim or glow', () => {
  const fallbacks = {
    'prefers-reduced-transparency': bodyOf(MODERN, '@media (prefers-reduced-transparency: reduce)'),
    'Reduce transparency switch': bodyOf(MODERN, `${PREFIX}[data-transparency='reduced'] {`),
    'no backdrop-filter': bodyOf(MODERN, '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
  };
  for (const [name, block] of Object.entries(fallbacks)) {
    const tokens = declared(block);
    for (const blur of ['--mat-glass-blur', '--mat-thick-blur', '--mat-frost-blur']) expect(tokens.get(blur), `${name} ${blur}`).toBe('0px');
    expect([tokens.get('--mat-rim'), tokens.get('--mat-glow'), tokens.get('--scrim')], name).toEqual(['none', 'none', 'transparent']);
    for (const scheme of ['light', 'dark'] as const) {
      for (const material of ['--mat-glass-bg', '--mat-thick-bg', '--mat-frost-bg']) {
        const value = (tokens.get(material) ?? '').replace(/var\((--[a-z0-9-]+)\)/g, (_all, inner: string) => resolve(scheme, inner));
        expect(parseColour(value).alpha, `${name}: ${scheme} ${material} is opaque`).toBe(1);
      }
    }
  }
  const contrast = declared(bodyOf(MODERN, '@media (prefers-contrast: more)'));
  expect([contrast.get('--mat-thick-bg'), contrast.get('--scrim')]).toEqual(['var(--m-solid)', 'var(--m-solid)']);
  const forced = declared(bodyOf(MODERN, '@media (forced-colors: active)'));
  expect([forced.get('--wallpaper'), forced.get('--elev-3'), forced.get('--mat-glass-bg')]).toEqual(['none', 'none', 'Canvas']);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`contrast on glass, ${scheme}: text on the scrim and on thick glass meets 4.5:1 over every wallpaper colour (§9.3)`, () => {
    const text = opaque(scheme, TEXT_ON_GLASS);
    const all = surfaces(scheme);
    for (const surface of ['scrim on glass', 'thick glass', 'solid (reduced transparency)'] as const) {
      const worst = Math.min(...(all[surface] ?? []).map((bg) => ratio(text, bg)));
      expect(worst, `${scheme}: ${TEXT_ON_GLASS} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`contrast on paper and frost, ${scheme}: the page's text tokens meet 4.5:1, the accent's ink on the accent too`, () => {
    const all = surfaces(scheme);
    for (const name of ['--ink', '--ink-soft', '--muted']) {
      const worst = Math.min(...(all['paper'] ?? []).map((bg) => ratio(opaque(scheme, name), bg)));
      expect(worst, `${scheme}: ${name} on paper`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ['frost', 'solid (reduced transparency)'] as const) {
      const worst = Math.min(...(all[surface] ?? []).map((bg) => ratio(opaque(scheme, '--ink'), bg)));
      expect(worst, `${scheme}: --ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(opaque(scheme, '--accent-ink'), opaque(scheme, '--accent')), `${scheme}: --accent-ink on --accent`).toBeGreaterThanOrEqual(4.5);
  });

  test(`the two-tone focus ring meets 3:1 on glass, scrim, frost and paper, ${scheme} (§9.2)`, () => {
    const ring = opaque(scheme, '--focus');
    const halo = opaque(scheme, '--focus-halo');
    for (const [surface, colours] of Object.entries(surfaces(scheme))) {
      const worst = Math.min(...colours.map((bg) => Math.max(ratio(ring, bg), ratio(halo, bg))));
      expect(worst, `${scheme}: focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
}

test('the wallpaper is a light and a dark SVG with no script, no link out and no embedded image', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const svg = WALLPAPER[scheme];
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<script|<foreignObject|href=|<image/i);
    expect(svg.length).toBeLessThan(40_000);
    expect(wallpaperColours(scheme).length).toBeGreaterThan(8);
  }
});
