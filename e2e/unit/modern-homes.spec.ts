import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import type { KeyAction } from '../../apps/desktop/src/app/keymap.js';
import { SHELL_ACTION_IDS } from '../../apps/desktop/src/app/shell-actions.js';
import { MODERN_HOMES, type Step } from '../modern-homes.js';

/**
 * MODERN_HOMES is all of §7 (M12, #313; modern-interface.md §1 G2, §7, §15.3): every row of the §7 tables, every shell action
 * (app/shell-actions.ts) and every chord the keymap resolves (app/keymap.ts) has a home in the table, and every home has a route
 * the reachability walk (e2e/modern-reachability.spec.ts) takes. A new Classic surface, action or chord fails here until it has its
 * Modern home.
 */

const SPEC = readFileSync(fileURLToPath(new URL('../../docs/architecture/modern-interface.md', import.meta.url)), 'utf8');

/** The first cell of every row of the §7 tables, by subsection, without its Markdown emphasis. */
function inventoryRows(): { readonly section: string; readonly surface: string }[] {
  const start = SPEC.indexOf('## 7. Inventory');
  const end = SPEC.indexOf('## 8. Interaction model');
  expect(start, '§7 is in the spec').toBeGreaterThan(0);
  const rows: { section: string; surface: string }[] = [];
  let section = '';
  for (const line of SPEC.slice(start, end).split('\n')) {
    const heading = /^### (7\.\d)/.exec(line);
    if (heading !== null) section = heading[1] ?? '';
    if (!line.startsWith('| ') || line.startsWith('| Classic surface') || line.startsWith('|---')) continue;
    rows.push({ section, surface: (line.split('|')[1] ?? '').trim().replace(/\*\*|`/g, '') });
  }
  return rows;
}

/** Every chord the keymap resolves. A `Record` over `KeyAction`, so a new chord fails type-checking until it is listed here. */
const CHORDS: Readonly<Record<KeyAction, true>> = {
  'new-document': true,
  rename: true,
  delete: true,
  'open-in-editor': true,
  'focus-mode': true,
  'focus-filter': true,
  undo: true,
  escape: true,
  'move-up': true,
  'move-down': true,
  'move-left': true,
  'move-right': true,
  'reorder-up': true,
  'reorder-down': true,
  'reparent-out': true,
  'reparent-in': true,
  'select-card': true,
  'open-menu': true,
  'agent-send': true,
  'agent-steer': true,
  'agent-stop': true,
  'agent-toggle': true,
  palette: true,
};

test('every row of §7 has its home in MODERN_HOMES, in its own subsection', () => {
  const rows = inventoryRows();
  expect(rows.length).toBeGreaterThanOrEqual(44);
  const missing = rows.filter((row) => !MODERN_HOMES.some((home) => home.section === row.section && home.classic === row.surface));
  expect(missing).toEqual([]);
});

test('every shell action has its home, and every home that names one names a real one', () => {
  const named = MODERN_HOMES.flatMap((home) => (home.action === undefined ? [] : [home.action]));
  expect([...named].sort()).toEqual([...SHELL_ACTION_IDS].sort());
});

test('every chord the keymap resolves has its home', () => {
  const covered = new Set(MODERN_HOMES.flatMap((home) => home.keys ?? []));
  expect(Object.keys(CHORDS).filter((chord) => !covered.has(chord))).toEqual([]);
  expect([...covered].filter((chord) => !(chord in CHORDS))).toEqual([]);
});

test('every home has at least one route, every route ends in something seen, and the ids are unique', () => {
  const ids = MODERN_HOMES.map((home) => home.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const home of MODERN_HOMES) {
    expect(home.routes.length, home.id).toBeGreaterThan(0);
    const titles = home.routes.map((route) => route.via);
    expect(new Set(titles).size, `${home.id}: route titles are unique`).toBe(titles.length);
    for (const route of home.routes) {
      const last: Step | undefined = route.steps.at(-1);
      const ends = last !== undefined && ('see' in last || 'offers' in last || 'menuHas' in last || ('download' in last && last.download === true));
      expect(ends, `${home.id}: ${route.via} ends in what the writer sees`).toBe(true);
      if (route.pending !== undefined) expect(route.why, `${home.id}: ${route.via} says why it is pending`).toBeTruthy();
    }
  }
});

test('the pending routes, by the issue that builds them (the list the gate still waits on)', () => {
  const pending = new Map<number, string[]>();
  for (const home of MODERN_HOMES) {
    for (const route of home.routes) {
      if (route.pending === undefined) continue;
      pending.set(route.pending, [...(pending.get(route.pending) ?? []), `${home.id}: ${route.via}`]);
    }
  }
  // Only the issues still in flight, and this issue's own gaps, may hold a route back.
  expect([...pending.keys()].every((issue) => [306, 311, 312, 313].includes(issue))).toBe(true);
  test.info().annotations.push(...[...pending].map(([issue, routes]) => ({ type: `pending #${issue}`, description: routes.join('; ') })));
});
