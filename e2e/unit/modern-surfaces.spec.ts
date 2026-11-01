import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * Modern's dialogs, menus and toasts (modern-interface.md §5.3, §7.6, §9.2, §9.3; M10, #311), read from surfaces-modern.css as written:
 *
 * - the light, system-dark and chosen-dark blocks define the same sheet primitives, the dark two with the same values, and none sets a
 *   material (`--mat-*`), so every fallback wins in both schemes;
 * - every transparency fallback (the system's, the Appearance switch, no backdrop-filter, more contrast) makes the sheets opaque;
 * - **contrast, computed** (§9.3; axe cannot see through backdrop-filter): Classic's text tokens as a dialog shows them (ink, soft ink,
 *   muted, danger, accent) on a dialog's sheet over its veil, and on a menu's or a toast's float glass without one, each composited over
 *   every colour the wallpaper draws, the paper and the solid surface (each taken as opaque, the worst case of any blend or blur), meet
 *   4.5:1, and the focus ring 3:1.
 */

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const SURFACES = read('../../apps/desktop/src/components/shell/modern/surfaces-modern.css');
const MODERN = read('../../apps/desktop/src/tokens/modern.css');
const CLASSIC = read('../../apps/desktop/src/tokens/classic.css');
const WALLPAPER = {
  light: read('../../apps/desktop/src/components/shell/modern/wallpaper-light.svg'),
  dark: read('../../apps/desktop/src/components/shell/modern/wallpaper-dark.svg'),
} as const;

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

function declared(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

const PREFIX = ":root[data-shell='modern']";
const LIGHT = `${PREFIX}:not([data-theme='dark']) {`;
const SYSTEM_DARK = `${PREFIX}:not([data-theme='light']) {`;
const CHOSEN_DARK = `${PREFIX}[data-theme='dark'] {`;

const own = {
  base: declared(bodyOf(SURFACES, `\n${PREFIX} {`)),
  light: declared(bodyOf(SURFACES, LIGHT)),
  systemDark: declared(bodyOf(SURFACES, SYSTEM_DARK)),
  chosenDark: declared(bodyOf(SURFACES, CHOSEN_DARK)),
};

const classicLight = declared(bodyOf(CLASSIC, '\n:root {'));
const classicDark = new Map([...classicLight, ...declared(bodyOf(CLASSIC, ":root[data-theme='dark'] {"))]);
const SCHEMES = {
  light: new Map([...classicLight, ...declared(bodyOf(MODERN, `\n${PREFIX} {`)), ...declared(bodyOf(MODERN, LIGHT)), ...own.base, ...own.light]),
  dark: new Map([...classicDark, ...declared(bodyOf(MODERN, `\n${PREFIX} {`)), ...declared(bodyOf(MODERN, CHOSEN_DARK)), ...own.base, ...own.chosenDark]),
} as const;
type Scheme = keyof typeof SCHEMES;

function resolve(scheme: Scheme, name: string, seen: readonly string[] = []): string {
  const value = SCHEMES[scheme].get(name);
  if (value === undefined) throw new Error(`${scheme}: ${name} is not defined`);
  if (seen.includes(name)) throw new Error(`${scheme}: ${name} refers to itself`);
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_all, inner: string) => resolve(scheme, inner, [...seen, name]));
}

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

const colour = (scheme: Scheme, name: string): Rgba => parseColour(resolve(scheme, name));
const opaque = (scheme: Scheme, name: string): Rgb => {
  const value = colour(scheme, name);
  expect(value.alpha, `${scheme} ${name} is opaque`).toBe(1);
  return value.rgb;
};

/** Everything that can be behind a dialog or a menu, each as opaque: every wallpaper colour, the paper and the solid surface. */
function behind(scheme: Scheme): Rgb[] {
  const wall = [...new Set([...WALLPAPER[scheme].matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase()))].map((hex) => parseColour(hex).rgb);
  return [...wall, opaque(scheme, '--surface-page'), opaque(scheme, '--m-solid')];
}

/** What text in each surface sits on. A dialog's sheet blurs its veil (the ::backdrop) over the page; a menu or a toast has no veil. */
function surfaces(scheme: Scheme): Record<'dialog sheet' | 'menu and toast', Rgb[]> {
  const sheet = colour(scheme, '--m-sheet');
  const float = colour(scheme, '--m-float');
  const veil = colour(scheme, '--m-veil');
  return {
    'dialog sheet': behind(scheme).map((bg) => over(sheet, over(veil, bg))),
    'menu and toast': behind(scheme).map((bg) => over(float, bg)),
  };
}

test('the light and both dark blocks define the same sheet primitives, the dark two alike, and none sets a material', () => {
  expect([...own.systemDark.keys()].sort()).toEqual([...own.light.keys()].sort());
  expect([...own.systemDark].sort()).toEqual([...own.chosenDark].sort());
  for (const name of own.light.keys()) expect(name.startsWith('--mat-'), name).toBe(false);
  for (const name of own.base.keys()) expect(name.startsWith('--mat-'), name).toBe(true);
});

test('every transparency fallback makes the sheets opaque', () => {
  const fallbacks = {
    'prefers-reduced-transparency': bodyOf(SURFACES, '@media (prefers-reduced-transparency: reduce)'),
    'Reduce transparency switch': bodyOf(SURFACES, `${PREFIX}[data-transparency='reduced'] {`),
    'no backdrop-filter': bodyOf(SURFACES, '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
    'more contrast': bodyOf(SURFACES, '@media (prefers-contrast: more)'),
  };
  for (const [name, block] of Object.entries(fallbacks)) {
    const tokens = declared(block);
    if (name !== 'more contrast') expect(tokens.get('--mat-sheet-blur'), name).toBe('0px');
    for (const scheme of ['light', 'dark'] as const) {
      for (const material of ['--mat-sheet-bg', '--mat-float-bg']) {
        const value = (tokens.get(material) ?? '').replace(/var\((--[a-z0-9-]+)\)/g, (_all, inner: string) => resolve(scheme, inner));
        expect(parseColour(value).alpha, `${name}: ${scheme} ${material} is opaque`).toBe(1);
      }
    }
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`contrast in dialogs, menus and toasts, ${scheme}: Classic's text tokens meet 4.5:1 over everything behind (§9.3)`, () => {
    for (const [surface, colours] of Object.entries(surfaces(scheme))) {
      for (const name of ['--ink', '--ink-soft', '--muted', '--danger', '--accent']) {
        const worst = Math.min(...colours.map((bg) => ratio(opaque(scheme, name), bg)));
        expect(worst, `${scheme}: ${name} on the ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      const worstRing = Math.min(...colours.map((bg) => Math.max(ratio(opaque(scheme, '--focus'), bg), ratio(opaque(scheme, '--focus-halo'), bg))));
      expect(worstRing, `${scheme}: focus ring on the ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
}
