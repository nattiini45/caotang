import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

import type { Pending, Setup, Step } from './modern-homes.js';
import { cspViolations, runStep, setUp, test, watchCsp } from './modern-walk.js';

/**
 * The Modern accessibility gate (M12, #313; modern-interface.md §9, §11, §15.3). Every Modern surface, in both schemes and on glass
 * and solid (the Reduce transparency switch), is held to:
 *
 * - **axe** (WCAG 2.2 A and AA, and best practice), everything but colour contrast, which axe cannot see through `backdrop-filter`;
 * - **contrast on glass, computed** (§9.3, D13): each piece of text's own colour over the layers behind it, down to the stage, then
 *   over every colour the wallpaper draws and the paper (each taken as opaque, the worst case of any blend or blur of them): 4.5:1,
 *   3:1 for large text;
 * - **the 44 px measure** (§9.5): every control at least 44 by 44 CSS px (a checkbox or radio with its label; a link in a sentence
 *   keeps its line).
 *
 * Then, on the default Write screen: **at most ten controls** outside the page (§9.5), and a **keyboard-only walk** (§9.1, §9.2): the
 * skip link first, the stops in reading order, each one shown with its ring. **Reduced motion** (the system's, and the switch) runs
 * no movement, only fades of 120 ms at most (§5.5, §8.3); **reduced transparency** (the system's) leaves no blur on any surface.
 * Opening every surface raises no **Content-Security-Policy** violation (§11).
 *
 * A surface still being built is `test.fixme` with the issue that builds it, as MODERN_HOMES does.
 */

test.use({ viewport: { width: 1440, height: 900 } });

interface Surface {
  readonly id: string;
  readonly setup: Setup;
  /** How a writer opens it, from its setup. */
  readonly open: readonly Step[];
  /** The element the checks run in. */
  readonly scope: string;
  readonly pending?: Pending;
  readonly why?: string;
}

const editor = { role: 'textbox', name: 'Document text', within: { css: '#modern-page' } } as const;

export const SURFACES: readonly Surface[] = [
  { id: 'the page (Write)', setup: 'scene', open: [], scope: '#modern-page' },
  { id: 'Scene info', setup: 'scene', open: [{ palette: 'Scene info' }, { see: { role: 'dialog', name: 'Scene info' } }], scope: '#modern-scene-info' },
  { id: 'the agent window', setup: 'scene', open: [{ press: 'ControlOrMeta+j', on: editor }, { see: { role: 'complementary', name: 'Agent' } }], scope: '#modern-companion' },
  {
    id: 'the palette',
    setup: 'scene',
    open: [{ press: 'ControlOrMeta+k', on: editor }, { type: 'the' }, { see: { role: 'dialog', name: 'Search and commands' } }],
    scope: 'dialog.modern-palette',
  },
  {
    id: 'the ornaments',
    setup: 'scene',
    open: [],
    scope: '[data-testid="modern-top-ornament"], [data-testid="modern-bottom-ornament"]',
  },
  { id: 'the ⋯ menu', setup: 'scene', open: [{ click: { testId: 'modern-more' } }], scope: '#modern-more-menu' },
  {
    id: 'Board',
    setup: 'scene',
    open: [{ click: { role: 'radio', name: 'Board', within: { role: 'navigation', name: 'Views and tools' } } }],
    scope: '#modern-page, [data-testid="modern-top-ornament"]',
  },
  {
    id: 'Codex',
    setup: 'scene',
    open: [{ click: { role: 'radio', name: 'Codex', within: { role: 'navigation', name: 'Views and tools' } } }],
    scope: '#modern-page',
  },
  {
    id: 'the sidebar',
    setup: 'scene',
    open: [{ click: { role: 'button', name: 'Manuscript', within: { role: 'navigation', name: 'Binder' } } }],
    scope: '[data-testid="modern-binder"]',
    pending: 307,
    why: 'the tab bar and the sidebar are #307’s',
  },
  { id: 'a toast', setup: 'scene', open: [{ provoke: 'deleted-scene' }, { see: { testId: 'modern-toast', pattern: 'Deleted' } }], scope: '[data-testid="modern-notices"]' },
  { id: 'Settings', setup: 'scene', open: [{ palette: 'Settings' }], scope: '[data-testid="settings"]' },
  { id: 'the Export dialog', setup: 'scene', open: [{ palette: 'Compile…' }], scope: 'dialog.export-dialog' },
  { id: 'the projects screen', setup: 'home', open: [], scope: '.home' },
  { id: 'the narrow layout', setup: 'scene', open: [], scope: '[data-testid="modern-stage"]', pending: 312, why: 'the narrow Modern layout is #312’s' },
];

const SCHEMES = ['light', 'dark'] as const;
const MATERIALS = ['glass', 'solid'] as const;

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
/** Every colour each scheme's wallpaper draws (its gradient stops, fills and strokes). */
const WALLPAPER: Readonly<Record<'light' | 'dark', readonly string[]>> = Object.fromEntries(
  SCHEMES.map((scheme) => [
    scheme,
    [...new Set([...read(`../apps/desktop/src/components/shell/modern/wallpaper-${scheme}.svg`).matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase()))],
  ]),
) as Record<'light' | 'dark', string[]>;

const AXE = createRequire(import.meta.url).resolve('axe-core');

async function open(page: Page, surface: Surface, options: { scheme?: 'light' | 'dark'; solid?: boolean } = {}): Promise<void> {
  await setUp(page, surface.setup, options);
  for (const step of surface.open) await runStep(page, step);
  await expect(page.locator(surface.scope).first()).toBeVisible();
  // Let a morph or a fade run out, so the checks read the surface where it rests.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
}

/** axe on the surface: WCAG 2.2 A/AA and best practice, without colour contrast (the computed check's) and the page-level rules. */
async function axeProblems(page: Page, scope: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (selector) => {
    const axe = (globalThis as unknown as {
      axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
    }).axe;
    const result = await axe.run(
      { include: [...document.querySelectorAll(selector)] },
      {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'page-has-heading-one': { enabled: false }, 'landmark-one-main': { enabled: false } },
      },
    );
    return result.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`));
  }, scope);
}

/**
 * The computed contrast of every piece of text in the surface (§9.3). The backdrop is every colour of the wallpaper and the paper;
 * each layer between it and the text (an ancestor's background, a gradient's colours, a material layer an ancestor draws behind its
 * content, a modal dialog's ::backdrop) is composited over it in order, and the text's own colour over the result.
 */
async function contrastProblems(page: Page, scope: string, wallpaper: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ({ selector, wall }) => {
      type Rgba = [number, number, number, number];
      const parse = (value: string): Rgba[] => {
        const found: Rgba[] = [];
        for (const match of value.matchAll(/rgba?\(([^)]+)\)/g)) {
          const parts = (match[1] ?? '').split(/[\s,/]+/).filter((part) => part !== '').map(Number);
          found.push([parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]);
        }
        for (const match of value.matchAll(/color\(srgb ([^)]+)\)/g)) {
          const parts = (match[1] ?? '').split(/[\s/]+/).filter((part) => part !== '').map(Number);
          found.push([(parts[0] ?? 0) * 255, (parts[1] ?? 0) * 255, (parts[2] ?? 0) * 255, parts[3] ?? 1]);
        }
        for (const match of value.matchAll(/#([0-9a-f]{6})\b/gi)) {
          const hex = match[1] ?? '000000';
          found.push([Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), 1]);
        }
        return found;
      };
      const over = (top: Rgba, below: Rgba): Rgba => [0, 1, 2].map((at) => (top[at] ?? 0) * top[3] + (below[at] ?? 0) * (1 - top[3])).concat(1) as Rgba;
      const luminance = (rgb: Rgba): number => {
        const [r, g, b] = [rgb[0], rgb[1], rgb[2]].map((channel) => {
          const c = channel / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: Rgba, b: Rgba): number => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const paper = parse(getComputedStyle(document.documentElement).getPropertyValue('--surface-page'));
      const backdrop: Rgba[] = [...wall.flatMap((hex) => parse(hex)), ...paper];

      /** The layers one element paints behind its content: its background colour, its gradient's colours as alternatives. */
      const layersOf = (element: Element, pseudo?: string): Rgba[][] => {
        const style = getComputedStyle(element, pseudo);
        const layers: Rgba[][] = [];
        const colour = parse(style.backgroundColor).filter((value) => value[3] > 0);
        if (colour.length > 0) layers.push(colour);
        if (style.backgroundImage.includes('gradient')) {
          const stops = parse(style.backgroundImage);
          if (stops.length > 0) layers.push(stops);
        }
        return layers;
      };
      /** The backgrounds behind an element, innermost first, each a set of alternatives; `null` means the stage's backdrop. */
      const stackOf = (element: Element): Rgba[][] => {
        const stack: Rgba[][] = [];
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          if (node.matches('[data-testid="modern-stage"], [data-testid="modern-wallpaper"]')) return stack;
          // A layer drawn behind the element's content as an aria-hidden sibling: a material (Scene info's glass), or a positioned
          // shape under this element (the bottom ornament's lens under the chosen view).
          const box = element.getBoundingClientRect();
          const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
          for (const child of node.children) {
            if (child.contains(element) || child.getAttribute('aria-hidden') !== 'true') continue;
            const material = /\bmat-/.test(child.className);
            const position = getComputedStyle(child).position;
            const under = child.getBoundingClientRect();
            const shape = (position === 'absolute' || position === 'fixed') && under.left <= x && x <= under.right && under.top <= y && y <= under.bottom;
            if (!material && !shape) continue;
            stack.push(...layersOf(child));
          }
          stack.push(...layersOf(node));
          if (node instanceof HTMLDialogElement && node.matches(':modal')) {
            stack.push(...layersOf(node, '::backdrop'));
            return stack;
          }
          if (stack.some((layer) => layer.every((value) => value[3] >= 1))) return stack;
        }
        return stack;
      };
      /** Every colour the element's background can show: the stack composited over each backdrop colour, every alternative. */
      const backgroundsOf = (element: Element): Rgba[] => {
        const stack = stackOf(element);
        let results: Rgba[] = backdrop;
        for (const layer of [...stack].reverse()) {
          results = layer.every((value) => value[3] >= 1) ? layer : results.flatMap((below) => layer.map((top) => over(top, below)));
          if (results.length > 400) results = results.slice(0, 400);
        }
        return results;
      };
      const shown = (element: Element): boolean => {
        if (element.closest('[aria-hidden="true"], [inert], [hidden]') !== null) return false;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        const box = element.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      };
      const problems: string[] = [];
      const seen = new Set<Element>();
      for (const root of document.querySelectorAll(selector)) {
        const candidates = [root, ...root.querySelectorAll('*')].filter(
          (element) =>
            element.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea, select') ||
            [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== ''),
        );
        for (const element of candidates) {
          if (seen.has(element) || !shown(element)) continue;
          seen.add(element);
          if (element.matches(':disabled, [aria-disabled="true"]') || element.closest(':disabled, [aria-disabled="true"]') !== null) continue;
          const style = getComputedStyle(element);
          const [fg] = parse(style.color);
          if (fg === undefined) continue;
          const size = Number.parseFloat(style.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          const needed = large ? 3 : 4.5;
          const worst = Math.min(...backgroundsOf(element).map((background) => ratio(over(fg, background), background)));
          if (worst < needed) {
            const text = (element.textContent ?? (element as HTMLInputElement).value ?? '').trim().slice(0, 40);
            const name = `${element.tagName.toLowerCase()}${element.id === '' ? '' : `#${element.id}`}.${[...element.classList].join('.')}`;
            problems.push(`${name} “${text}”: ${worst.toFixed(2)} < ${needed}`);
          }
        }
      }
      return problems;
    },
    { selector: scope, wall: wallpaper },
  );
}

/** Every control in the surface smaller than 44 by 44 CSS px (§9.5). */
async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const CONTROLS = [
      'button',
      'a[href]',
      'input:not([type=hidden])',
      'select',
      'textarea',
      'summary',
      '[role=button]',
      '[role=tab]',
      '[role=menuitem]',
      '[role=menuitemradio]',
      '[role=menuitemcheckbox]',
      '[role=option]',
      '[role=radio]',
      '[role=checkbox]',
      '[role=switch]',
      '[role=treeitem]',
      '[role=combobox]',
    ].join(', ');
    const problems: string[] = [];
    const seen = new Set<Element>();
    for (const root of document.querySelectorAll(selector)) {
      for (const element of [root, ...root.querySelectorAll('*')]) {
        if (seen.has(element) || !element.matches(CONTROLS)) continue;
        seen.add(element);
        if (element.closest('[aria-hidden="true"], [inert], [hidden]') !== null) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        // A link (or a button drawn as one) inside a sentence keeps its line (WCAG 2.5.8's inline exception).
        if (element.matches('a, button') && [...(element.parentElement?.childNodes ?? [])].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '')) continue;
        // A checkbox or radio counts with its label; a tree row is its own line, not its subtree.
        let measured: Element = element;
        if (element.matches('input[type=checkbox], input[type=radio]')) measured = element.closest('label') ?? (element.id === '' ? null : document.querySelector(`label[for="${element.id}"]`)) ?? element;
        if (element.matches('[role=treeitem]')) measured = element.querySelector(':scope > .row') ?? element;
        const box = measured.getBoundingClientRect();
        // Nothing to hit: a visually hidden control (a file input behind its label button) is not a target.
        if (box.width <= 2 && box.height <= 2) continue;
        if (box.width < 43.5 || box.height < 43.5) {
          const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30);
          problems.push(`${element.tagName.toLowerCase()}${element.getAttribute('role') === null ? '' : `[role=${element.getAttribute('role') ?? ''}]`} “${name}”: ${Math.round(box.width)}×${Math.round(box.height)}`);
        }
      }
    }
    return problems;
  }, scope);
}

type Check = 'axe' | 'contrast' | '44 px';

/**
 * The gaps the gate has found on surfaces that are built, each pinned to what it is (a pattern over the problem as the check words
 * it, without its measure), so a new problem anywhere else still fails. #313 closes them before Modern becomes the default; a fix
 * removes its line. A gap that a browser does not show is fine; a problem not listed here is not.
 */
const GAPS: readonly { readonly surface: string; readonly check: Check; readonly patterns: readonly string[]; readonly why: string }[] = [
  {
    surface: 'the page (Write)',
    check: '44 px',
    patterns: ['^button “Insert picture”', '^button “Add footnote”', '^button “.*words today'],
    why: 'the editor’s picture and footnote buttons are 24–30 px tall, and the editor footer (its target quick-set) is still on the page, not in Scene info › Progress (§7.3)',
  },
  {
    surface: 'Scene info',
    check: 'contrast',
    patterns: ['^(p|li)\\.field-note '],
    why: 'the inspector’s field notes (--muted) reach about 3:1 on thick glass over the light wallpaper',
  },
  {
    surface: 'Scene info',
    check: '44 px',
    patterns: ['^button “(Status|Label): ', '^(input|select|summary) “', '^button “(Add thread|Link|Import pictures here…|Attach to this paragraph)”'],
    why: 'the inspector’s fields, pickers and buttons keep Classic’s 23–35 px heights inside Scene info',
  },
  { surface: 'the agent window', check: 'axe', patterns: ['^heading-order'], why: 'the agent panel’s headings skip a level (an h4) in the window' },
  { surface: 'the agent window', check: 'contrast', patterns: ['agent-close'], why: 'the panel’s quiet Close button is about 2.5:1 (light) and 3.3:1 (dark) on glass' },
  {
    surface: 'the agent window',
    check: '44 px',
    patterns: ['^input “”', '^button “New task”'],
    why: 'the agent panel’s checkboxes with their labels are 21 px tall, and New task 30 px',
  },
  ...(['the ornaments', 'Board'] as const).map((surface) => ({
    surface,
    check: 'contrast' as const,
    patterns: ['^span\\.save-state\\.'],
    why: 'the save state in the top ornament (--muted) sits on the ornament’s thin glass, about 1.1–1.3:1 over the wallpaper’s mid tones',
  })),
  {
    surface: 'Board',
    check: '44 px',
    patterns: ['^button “New card”', '^button\\[role=radio\\] “[SML]: '],
    why: 'the corkboard keeps Classic’s toolbar on the page: New card 30 px and the S / M / L zoom 26 px tall (§7.3 puts the zoom in the top ornament)',
  },
  {
    surface: 'Codex',
    check: '44 px',
    patterns: ['^button “(Always|Never|Detected|Manual|Character|Location|Object|Lore|Subplot|Other)”', '^button “(New entry|Let the agent draft entries)', '^input “Search the codex”'],
    why: 'the codex on the page keeps Classic’s 25 px filter chips, its 30 px buttons and its 34 px search field',
  },
];

/** The problems no gap explains. */
function unexplained(surface: string, check: Check, problems: readonly string[]): string[] {
  const patterns = GAPS.filter((gap) => gap.surface === surface && gap.check === check).flatMap((gap) => gap.patterns.map((pattern) => new RegExp(pattern)));
  return problems.filter((problem) => !patterns.some((pattern) => pattern.test(problem)));
}

for (const surface of SURFACES) {
  test.describe(`${surface.id}`, () => {
    // axe is injected as an inline script, which the app's policy refuses; the CSP listener has its own test below, without this.
    test.use({ bypassCSP: true, setup: surface.setup });
    for (const scheme of SCHEMES) {
      for (const material of MATERIALS) {
        test(`${scheme}, ${material}: axe, contrast computed on ${material}, every control 44 px`, async ({ page, browserName }) => {
          test.fixme(surface.pending !== undefined, `#${surface.pending ?? ''}: ${surface.why ?? ''}`);
          // Solid is the same CSS in every engine (no backdrop-filter to differ on), so Chromium alone holds it; glass runs everywhere.
          test.skip(material === 'solid' && browserName !== 'chromium', 'the solid material is checked in Chromium');
          for (const gap of GAPS.filter((each) => each.surface === surface.id)) test.info().annotations.push({ type: `gap #313 (${gap.check})`, description: gap.why });
          await open(page, surface, { scheme, solid: material === 'solid' });
          await expect(page.locator('html')).toHaveAttribute('data-shell', 'modern');
          if (material === 'solid') await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduced');
          expect.soft(unexplained(surface.id, 'axe', await axeProblems(page, surface.scope)), 'axe').toEqual([]);
          expect.soft(unexplained(surface.id, 'contrast', await contrastProblems(page, surface.scope, WALLPAPER[scheme])), `contrast on ${material}`).toEqual([]);
          expect.soft(unexplained(surface.id, '44 px', await smallTargets(page, surface.scope)), '44 px').toEqual([]);
        });
      }
    }
  });
}

test.describe('the default Write screen', () => {
  test('at most ten controls outside the page, and they are the nine of §9.5', async ({ page }) => {
    test.fixme(true, '#307: the binder is still on the page until the tab bar (#307) and the ornaments (#306) replace the provisional ones');
    await setUp(page, 'scene');
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="modern-stage"] *')]
        .filter((element) => element.matches('button, a[href], input, select, textarea, summary, [role=button], [role=radio], [role=tab], [tabindex="0"]'))
        .filter((element) => element.closest('#modern-page, [inert], [hidden], [aria-hidden="true"], .modern-skip') === null)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== 'hidden';
        })
        .map((element) => element.getAttribute('aria-label') ?? (element.textContent ?? '').trim()),
    );
    expect(controls.length, controls.join(' · ')).toBeLessThanOrEqual(10);
    for (const name of ['More', 'Write', 'Board', 'Codex', 'Ask', 'Search', 'Manuscript', 'Panels']) expect(controls.some((control) => control.startsWith(name)), name).toBe(true);
  });

  test('keyboard only: the skip link first, then every stop in reading order, each shown with its ring', async ({ page }) => {
    await setUp(page, 'scene');
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the page' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#modern-page')).toBeFocused();

    // From the skip link: Tab through every stop of the screen, until focus comes round to the skip link again.
    await skip.focus();
    const stops: { region: string; ring: boolean; shown: boolean; name: string }[] = [{ region: 'skip', ring: true, shown: true, name: 'Skip to the page' }];
    for (let at = 0; at < 250; at += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return null;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const region =
          element.closest('.modern-skip') !== null
            ? 'skip'
            : element.closest('[data-testid="modern-top-ornament"]') !== null
              ? 'top'
              : element.closest('[data-testid="modern-binder"], [data-testid="modern-sidebar"]') !== null
                ? 'binder'
                : element.closest('#modern-page') !== null
                  ? 'page'
                  : element.closest('[data-testid="modern-bottom-ornament"]') !== null
                    ? 'bottom'
                    : element.closest('[data-testid="modern-notices"]') !== null
                      ? 'notices'
                      : 'other';
        // A text field shows its caret where it has focus, which is its indicator; every other stop draws a ring.
        const typing = element.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable="true"]');
        const ring = typing || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
        const shown = box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
        return { region, ring, shown, name: element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30) };
      });
      if (stop === null) continue;
      if (stop.region === 'skip') break;
      stops.push(stop);
    }
    expect(stops.length).toBeGreaterThan(3);
    expect(stops[0]?.region).toBe('skip');
    // The reading order of §9.1: notices, top ornament, binder, page, bottom ornament (each region entered once, in this order).
    const ORDER = ['skip', 'notices', 'top', 'binder', 'page', 'bottom', 'other'];
    const regions = stops.map((stop) => stop.region).filter((region, index, all) => region !== all[index - 1]);
    expect(regions, regions.join(' → ')).toEqual([...new Set(regions)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
    expect(stops.filter((stop) => !stop.shown).map((stop) => `${stop.region}: ${stop.name}`), 'every stop is on the screen').toEqual([]);
    expect(stops.filter((stop) => !stop.ring).map((stop) => `${stop.region}: ${stop.name}`), 'every stop shows its ring').toEqual([]);
  });
});

/** The animations running on the page after a surface opened: anything that moves, or fades for longer than 120 ms. */
async function movement(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document.getAnimations().flatMap((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect === null) return [];
      const timing = effect.getComputedTiming();
      const duration = typeof timing.duration === 'number' ? timing.duration : 0;
      if (duration === 0) return [];
      const properties = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))));
      if ('transitionProperty' in animation) properties.add(String((animation as unknown as { transitionProperty: string }).transitionProperty));
      const onlyFades = [...properties].every((property) => property === 'opacity');
      if (onlyFades && duration <= 120) return [];
      const target = effect.target;
      return [`${target === null ? '?' : `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}`}: ${[...properties].join(', ')} ${duration} ms`];
    }),
  );
}

test.describe('reduced motion', () => {
  for (const source of ['the system', 'the Reduce motion switch'] as const) {
    test(`${source}: opening each surface moves nothing, and fades take 120 ms at most`, async ({ page }) => {
      // One test opens every built surface in turn, so it has the time of several.
      test.slow();
      if (source === 'the system') await page.emulateMedia({ reducedMotion: 'reduce' });
      else await page.addInitScript(() => localStorage.setItem('caotang.modern.motion', 'reduced'));
      await setUp(page, 'scene');
      for (const surface of SURFACES.filter((each) => each.pending === undefined && each.setup === 'scene')) {
        for (const step of surface.open) await runStep(page, step);
        expect.soft(await movement(page), surface.id).toEqual([]);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
    });
  }
});

test('the system’s reduced transparency: no surface is blurred or see-through', async ({ page, browserName }) => {
  test.slow();
  test.skip(browserName !== 'chromium', 'Reduced transparency is emulated through Chromium’s DevTools protocol.');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await setUp(page, 'scene');
  test.skip(!(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)), 'This Chromium does not know the query.');
  for (const surface of SURFACES.filter((each) => each.pending === undefined && each.setup === 'scene')) {
    for (const step of surface.open) await runStep(page, step);
    const glassy = await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(`${selector}, ${selector} *, [class*="mat-"]`)].flatMap((element) => {
          const style = getComputedStyle(element);
          const blur = style.getPropertyValue('backdrop-filter');
          return /blur\([1-9]/.test(blur) ? [`${element.tagName.toLowerCase()}.${[...element.classList].join('.')}: ${blur}`] : [];
        }),
      surface.scope,
    );
    expect.soft(glassy, surface.id).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
});

test.describe('the Content-Security-Policy listener', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: opening every surface raises no violation`, async ({ page }) => {
      test.slow();
      await watchCsp(page);
      await setUp(page, 'scene', { scheme });
      for (const surface of SURFACES.filter((each) => each.pending === undefined && each.setup === 'scene')) {
        for (const step of surface.open) await runStep(page, step);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
      expect(await cspViolations(page)).toEqual([]);
    });
  }
});
