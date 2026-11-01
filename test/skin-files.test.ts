/**
 * A Classic skin is token values only (modern-interface.md §2.2, §15.2; apps/desktop/src/tokens/skins/README.md). Every file in
 * `apps/desktop/src/tokens/skins/` other than the README is a skin `<name>.css` that holds nothing but token blocks under its own
 * `:root[data-shell='classic'][data-skin='<name>']` selector: no component selector, no plain property, no token Classic does not
 * define, and no at-rule beyond the scheme and the two preference queries. Motion tokens sit behind
 * `prefers-reduced-motion: no-preference`, and materials or translucent colours behind `prefers-reduced-transparency: no-preference`,
 * so a skin cannot take away what a writer's system asked for.
 *
 * No skin ships, so the scan over the folder checks nothing yet; the rule itself is run against written fixtures below, so the guard
 * is not vacuous.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const SKINS = resolve(repoRoot, 'apps/desktop/src/tokens/skins');
const CLASSIC = resolve(repoRoot, 'apps/desktop/src/tokens/classic.css');

const SKIN_FILE = /^([a-z][a-z0-9-]*)\.css$/;
const MEDIA = {
  dark: '(prefers-color-scheme: dark)',
  motion: '(prefers-reduced-motion: no-preference)',
  transparency: '(prefers-reduced-transparency: no-preference)',
} as const;
type Media = keyof typeof MEDIA;

/** Every custom property tokens/classic.css declares, in any block. */
function classicTokens(): ReadonlySet<string> {
  const css = readFileSync(CLASSIC, 'utf8');
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? ''));
}

/** Whether a colour value lets what is behind it show through. */
function translucent(value: string): boolean {
  if (/\btransparent\b/i.test(value)) return true;
  for (const match of value.matchAll(/#([0-9a-f]{4}|[0-9a-f]{8})\b/gi)) {
    const hex = match[1] ?? '';
    if (!/^(?:f|ff)$/i.test(hex.length === 4 ? hex.slice(3) : hex.slice(6))) return true;
  }
  for (const match of value.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^)]*)\)/gi)) {
    const args = match[1] ?? '';
    const alpha = args.includes('/') ? args.split('/')[1] : args.split(',').length === 4 ? args.split(',')[3] : undefined;
    if (alpha === undefined) continue;
    const text = alpha.trim();
    const amount = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
    if (!(amount >= 1)) return true;
  }
  return false;
}

/** The problems in one skin file, empty when it holds only token blocks. */
function skinProblems(name: string, source: string, tokens: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const base = `:root[data-shell='classic'][data-skin='${name}']`;
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const media: Array<Media | null> = [];
  const blocks: Array<'media' | 'rule'> = [];
  let buffer = '';

  const declaration = (raw: string): void => {
    const decl = raw.trim();
    if (decl === '') return;
    const colon = decl.indexOf(':');
    const property = (colon < 0 ? decl : decl.slice(0, colon)).trim();
    const value = colon < 0 ? '' : decl.slice(colon + 1).trim();
    if (blocks.at(-1) !== 'rule') {
      problems.push(`"${decl}" stands outside a token block`);
      return;
    }
    if (!property.startsWith('--')) {
      problems.push(`${property} is not a token: a skin sets token values only`);
      return;
    }
    if (!tokens.has(property)) problems.push(`${property} is not a token tokens/classic.css defines`);
    if (/^--(?:dur|ease)-/.test(property) && !media.includes('motion')) {
      problems.push(`${property} is motion: set it inside @media ${MEDIA.motion}`);
    }
    const material = /^--(?:mat-|scrim$|wallpaper$)/.test(property);
    const shadow = /^--(?:shadow$|elev-|focus-halo$)/.test(property);
    if (!media.includes('transparency') && (material || (!shadow && translucent(value)))) {
      problems.push(`${property} ${material ? 'is a material' : 'is not opaque'}: set it inside @media ${MEDIA.transparency}`);
    }
  };

  for (const char of text) {
    if (char === '{') {
      const prelude = buffer.trim().replace(/\s+/g, ' ');
      buffer = '';
      if (prelude.startsWith('@')) {
        const query = prelude.replace(/^@media\s*/, '');
        const kind = (Object.keys(MEDIA) as Media[]).find((key) => prelude.startsWith('@media') && MEDIA[key] === query);
        if (kind === undefined) problems.push(`${prelude} is not an at-rule a skin may use`);
        if (blocks.at(-1) === 'rule') problems.push(`${prelude} is nested in a rule`);
        media.push(kind ?? null);
        blocks.push('media');
        continue;
      }
      if (blocks.at(-1) === 'rule') problems.push(`${prelude} is nested in a rule`);
      for (const selector of prelude.split(',').map((part) => part.trim())) {
        const ok =
          selector === base ||
          selector === `${base}[data-theme='dark']` ||
          (selector === `${base}:not([data-theme='light'])` && media.includes('dark'));
        if (!ok) problems.push(`${selector} is not ${base}, its [data-theme='dark'] form, or its :not([data-theme='light']) form in the dark query`);
      }
      blocks.push('rule');
      continue;
    }
    if (char === '}') {
      declaration(buffer);
      buffer = '';
      if (blocks.pop() === 'media') media.pop();
      continue;
    }
    if (char === ';') {
      if (blocks.length === 0) {
        if (buffer.trim() !== '') problems.push(`${buffer.trim()} is not a token block`);
      } else declaration(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  if (buffer.trim() !== '') problems.push(`"${buffer.trim()}" is left over outside a block`);
  return problems;
}

describe('Classic skin files', () => {
  const tokens = classicTokens();

  it('the folder holds the README and skin files only, and each skin holds only its token blocks', () => {
    const entries = readdirSync(SKINS);
    expect(entries).toContain('README.md');
    for (const entry of entries) {
      if (entry === 'README.md') continue;
      const name = SKIN_FILE.exec(entry)?.[1];
      expect(name, `${entry} is not a skin file <name>.css`).toBeDefined();
      expect(name, 'default is Classic itself, not a file').not.toBe('default');
      expect(skinProblems(name ?? '', readFileSync(resolve(SKINS, entry), 'utf8'), tokens), entry).toEqual([]);
    }
  });

  it('reads the token names from tokens/classic.css', () => {
    expect(tokens.has('--paper')).toBe(true);
    expect(tokens.has('--radius-md')).toBe(true);
    expect(tokens.has('--dur-2')).toBe(true);
  });

  const good = `
/* A calm skin. */
:root[data-shell='classic'][data-skin='calm'] {
  --paper: #fbfaf7;
  --radius-sm: 8px;
  --elev-2: var(--shadow), 0 8px 24px rgba(0, 0, 0, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root[data-shell='classic'][data-skin='calm']:not([data-theme='light']) {
    --paper: #141311;
  }
}

:root[data-shell='classic'][data-skin='calm'][data-theme='dark'] {
  --paper: #141311;
}

@media (prefers-reduced-motion: no-preference) {
  :root[data-shell='classic'][data-skin='calm'] {
    --dur-2: 0.24s;
    --ease-standard: cubic-bezier(0.32, 0.72, 0, 1);
  }
}

@media (prefers-reduced-transparency: no-preference) {
  :root[data-shell='classic'][data-skin='calm'] {
    --mat-thick-bg: rgba(255, 250, 248, 0.4);
    --panel: #f2f0ebcc;
  }
}
`;

  it('passes a skin of token blocks under its own selector', () => {
    expect(skinProblems('calm', good, tokens)).toEqual([]);
  });

  it('refuses a component selector, another skin’s selector, a Modern selector and a selector list that hides one', () => {
    const css = `
.toolbar { --paper: #fff; }
:root[data-shell='classic'][data-skin='glass'] { --paper: #fff; }
:root[data-shell='modern'] { --paper: #fff; }
:root[data-shell='classic'][data-skin='calm'], .binder { --paper: #fff; }
:root[data-shell='classic'][data-skin='calm']:not([data-theme='light']) { --paper: #fff; }
`;
    const problems = skinProblems('calm', css, tokens);
    expect(problems.filter((problem) => problem.includes('is not :root'))).toHaveLength(5);
  });

  it('refuses a plain property, an unknown token, an at-rule beyond the three queries, and a nested rule', () => {
    const css = `
@import url('other.css');
@font-face { font-family: X; }
@media (min-width: 900px) { :root[data-shell='classic'][data-skin='calm'] { --paper: #fff; } }
:root[data-shell='classic'][data-skin='calm'] {
  color: red;
  --brand-new: 1px;
  .row { --paper: #fff; }
}
`;
    const problems = skinProblems('calm', css, tokens);
    expect(problems.some((problem) => problem.startsWith('@import'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('@font-face'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('@media (min-width: 900px)'))).toBe(true);
    expect(problems).toContain('color is not a token: a skin sets token values only');
    expect(problems).toContain('--brand-new is not a token tokens/classic.css defines');
    expect(problems.some((problem) => problem.includes('nested in a rule'))).toBe(true);
  });

  it('refuses motion outside reduced-motion no-preference, and materials or translucent colours outside reduced-transparency no-preference', () => {
    const css = `
:root[data-shell='classic'][data-skin='calm'] {
  --dur-2: 0.3s;
  --ease-spring: cubic-bezier(0.3, 1.22, 0.42, 1);
  --mat-glass-bg: #ffffff;
  --scrim: rgb(0 0 0 / 30%);
  --panel: rgba(242, 240, 235, 0.8);
  --raised: #ffffff80;
  --line: transparent;
  --paper: rgba(250, 249, 246, 1);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}
`;
    const problems = skinProblems('calm', css, tokens);
    expect(problems).toEqual([
      `--dur-2 is motion: set it inside @media ${MEDIA.motion}`,
      `--ease-spring is motion: set it inside @media ${MEDIA.motion}`,
      `--mat-glass-bg is a material: set it inside @media ${MEDIA.transparency}`,
      `--scrim is a material: set it inside @media ${MEDIA.transparency}`,
      `--panel is not opaque: set it inside @media ${MEDIA.transparency}`,
      `--raised is not opaque: set it inside @media ${MEDIA.transparency}`,
      `--line is not opaque: set it inside @media ${MEDIA.transparency}`,
    ]);
  });
});
