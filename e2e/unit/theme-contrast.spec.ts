import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * The muted text, and the warning colour the filter chips use, meet 4.5:1 on the token surfaces they sit on, in the light theme and in
 * both dark blocks (WCAG 2.2 1.4.3; ui-modules §0 item 5). The ratios come from the stylesheet's own tokens, so an edit that drops a
 * token below the bar fails here. The rendered page is scanned separately by axe-core (e2e/a11y-surfaces.spec.ts).
 */

const STYLES = fileURLToPath(new URL('../../apps/desktop/src/styles.css', import.meta.url));

/** The body of the rule whose selector text is `marker`, from its opening brace to the matching close. */
function bodyOf(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no rule "${marker}" in styles.css`);
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

/** The hex colour tokens a block declares, by name. */
function tokensOf(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens[name] = value;
  }
  return tokens;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio of two `#rrggbb` colours, from 1 to 21. */
function contrastOf(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const css = readFileSync(STYLES, 'utf8');
const THEMES: readonly { readonly name: string; readonly tokens: Record<string, string> }[] = [
  { name: 'light', tokens: tokensOf(bodyOf(css, '\n:root {')) },
  { name: 'dark (system)', tokens: tokensOf(bodyOf(css, ":root:not([data-theme='light']) {")) },
  { name: 'dark (chosen)', tokens: tokensOf(bodyOf(css, ":root[data-theme='dark'] {")) },
];
/**
 * The four token surfaces this file reads: the page (`--paper`), the rail and footer (`--panel`), the raised fields (`--raised`), and a
 * selected row (`--accent-soft`). This is a token check, not a page scan: the rendered rail and footer are scanned by axe in
 * e2e/a11y-surfaces.spec.ts, which also catches a colour a component sets on its own.
 */
const SURFACES = ['--paper', '--panel', '--raised', '--accent-soft'] as const;
const TEXT = ['--muted', '--warn'] as const;

test('every theme declares the surfaces and the text colours the check reads', () => {
  for (const theme of THEMES) {
    for (const name of [...SURFACES, ...TEXT]) {
      expect(theme.tokens[name.slice(2)], `${theme.name} declares ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  }
});

test('muted text meets 4.5:1 on the four token surfaces (paper, panel, raised, accent-soft) in the light and both dark themes', () => {
  for (const theme of THEMES) {
    const muted = theme.tokens['muted'] ?? '';
    for (const surface of SURFACES) {
      const background = theme.tokens[surface.slice(2)] ?? '';
      expect(contrastOf(muted, background), `${theme.name}: ${muted} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('the warning colour that marks an unknown status meets 4.5:1 on the same four token surfaces', () => {
  for (const theme of THEMES) {
    const warn = theme.tokens['warn'] ?? '';
    for (const surface of SURFACES) {
      const background = theme.tokens[surface.slice(2)] ?? '';
      expect(contrastOf(warn, background), `${theme.name}: ${warn} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

/**
 * Apply-then-review (editor-engine §15): the words an agent edit added and removed are drawn on a tint, and the text on that tint meets
 * 4.5:1 in the light theme and both dark blocks. The tint is never the only cue: the insertion rule underlines and the deletion rule
 * strikes through.
 */
test('review marks: the ink on the insertion and deletion tints meets 4.5:1 in every theme, and each mark has a cue besides colour', () => {
  for (const theme of THEMES) {
    for (const kind of ['add', 'del'] as const) {
      const ink = theme.tokens[`suggest-${kind}-ink`] ?? '';
      const background = theme.tokens[`suggest-${kind}-bg`] ?? '';
      expect(background, `${theme.name} declares the ${kind} tint`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastOf(ink, background), `${theme.name}: ${ink} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(bodyOf(css, '.suggestion-insertion {')).toMatch(/text-decoration:\s*underline/);
  expect(bodyOf(css, '.suggestion-deletion {')).toMatch(/text-decoration:\s*line-through/);
});
