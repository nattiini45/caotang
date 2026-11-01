import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * Token parity (modern-interface.md §5.1, §5.4, §15.1): every semantic token is defined for Classic in the light theme and in both dark
 * blocks (the system query and the chosen theme), every token it names resolves there, and the two dark blocks agree. Each token that
 * replaced a literal keeps that literal as its Classic value, so Classic renders as it did; the colour values are theme-contrast's
 * (e2e/unit/theme-contrast.spec.ts) and the pixels the Classic snapshots' (e2e/visual/).
 */

const CLASSIC = fileURLToPath(new URL('../../apps/desktop/src/tokens/classic.css', import.meta.url));
const css = readFileSync(CLASSIC, 'utf8');

/** The body of the rule whose selector text is `marker`, from its opening brace to the matching close. */
function bodyOf(marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no rule "${marker}" in tokens/classic.css`);
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

/** The custom properties a block declares, by name, comments left out. */
function declared(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

const light = declared(bodyOf('\n:root {'));
const systemDark = declared(bodyOf(":root:not([data-theme='light']) {"));
const chosenDark = declared(bodyOf(":root[data-theme='dark'] {"));
const THEMES = [
  { name: 'light', tokens: light },
  { name: 'dark (system)', tokens: new Map([...light, ...systemDark]) },
  { name: 'dark (chosen)', tokens: new Map([...light, ...chosenDark]) },
] as const;

/** Classic's semantic tokens: the existing names (D6), then the ones this layer adds. */
const SEMANTIC = [
  // Colour, type and layout (D6): names and values unchanged.
  '--paper', '--panel', '--raised', '--ink', '--ink-soft', '--muted', '--line', '--line-strong', '--accent', '--accent-ink', '--accent-soft',
  '--danger', '--danger-soft', '--warn', '--focus', '--suggest-add-bg', '--suggest-add-ink', '--suggest-del-bg', '--suggest-del-ink',
  '--dot-empty', '--shadow', '--radius', '--ui', '--manuscript', '--rail-w', '--inspector-w', '--ok', '--ok-soft', '--review', '--review-soft',
  // Surfaces.
  '--surface-app', '--surface-page',
  // Shape.
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill',
  // Space and density.
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--control-h', '--control-pad-x', '--target-min', '--row-h',
  // Elevation.
  '--elev-0', '--elev-1', '--elev-2', '--elev-3',
  // Focus.
  '--focus-width', '--focus-offset', '--focus-halo',
  // Motion.
  '--dur-1', '--dur-2', '--dur-3', '--ease-standard', '--ease-spring',
  // Type scale.
  '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--leading-ui', '--leading-prose',
  // Materials (Modern's; solid in Classic).
  '--mat-glass-bg', '--mat-glass-blur', '--mat-glass-saturate', '--mat-glass-edge-hi', '--mat-glass-edge-lo', '--mat-thick-bg', '--mat-thick-blur',
  '--mat-frost-bg', '--scrim', '--wallpaper',
] as const;

/**
 * Each new token's Classic value: the literal it replaced (or an alias of the token that held it), as modern-interface.md §5.1 lists
 * them. A change here changes Classic's pixels.
 */
const CLASSIC_VALUES: Readonly<Record<string, string>> = {
  '--surface-app': 'var(--paper)',
  '--surface-page': 'var(--paper)',
  '--radius-xs': '4px',
  '--radius-sm': '6px',
  '--radius-md': 'var(--radius)',
  '--radius-lg': '12px',
  '--radius-pill': '999px',
  '--space-1': '2px',
  '--space-2': '4px',
  '--space-3': '6px',
  '--space-4': '8px',
  '--space-5': '12px',
  '--space-6': '16px',
  '--control-h': 'auto',
  '--control-pad-x': '12px',
  '--target-min': '24px',
  '--row-h': '30px',
  '--elev-0': 'none',
  '--elev-1': 'var(--shadow)',
  '--elev-2': 'var(--shadow), 0 8px 24px rgba(0, 0, 0, 0.12)',
  '--elev-3': 'var(--shadow), 0 12px 40px rgba(0, 0, 0, 0.18)',
  '--focus-width': '2px',
  '--focus-offset': '2px',
  '--focus-halo': 'none',
  '--dur-1': '0s',
  '--dur-2': '0.2s',
  '--dur-3': '0s',
  '--ease-standard': 'ease',
  '--ease-spring': 'ease',
  '--text-xs': '11.5px',
  '--text-sm': '12px',
  '--text-md': '12.5px',
  '--text-lg': '13px',
  '--text-xl': '14px',
  '--leading-ui': '1.45',
  '--leading-prose': '1.7',
  '--mat-glass-bg': 'var(--raised)',
  '--mat-glass-blur': '0px',
  '--mat-glass-saturate': '100%',
  '--mat-glass-edge-hi': 'transparent',
  '--mat-glass-edge-lo': 'transparent',
  '--mat-thick-bg': 'var(--raised)',
  '--mat-thick-blur': '0px',
  '--mat-frost-bg': 'var(--paper)',
  '--scrim': 'transparent',
  '--wallpaper': 'none',
};

test('every semantic token is defined in Classic light and in both Classic dark blocks', () => {
  for (const theme of THEMES) {
    for (const name of SEMANTIC) expect(theme.tokens.has(name), `${theme.name} defines ${name}`).toBe(true);
  }
});

test('every token a Classic token names resolves in light and both dark blocks', () => {
  for (const theme of THEMES) {
    for (const [name, value] of theme.tokens) {
      for (const match of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
        expect(theme.tokens.has(match[1] ?? ''), `${theme.name}: ${name} names ${match[1]}`).toBe(true);
      }
    }
  }
});

test('the two dark blocks redefine the same tokens with the same values, and only tokens light defines', () => {
  expect([...systemDark].sort()).toEqual([...chosenDark].sort());
  for (const name of systemDark.keys()) expect(light.has(name), `light defines ${name}`).toBe(true);
});

test('the new tokens keep the Classic values of the literals they replaced, in every scheme', () => {
  expect(Object.keys(CLASSIC_VALUES).sort()).toEqual(SEMANTIC.filter((name) => CLASSIC_VALUES[name] !== undefined).sort());
  for (const theme of THEMES) {
    for (const [name, value] of Object.entries(CLASSIC_VALUES)) expect(theme.tokens.get(name), `${theme.name} ${name}`).toBe(value);
  }
});
