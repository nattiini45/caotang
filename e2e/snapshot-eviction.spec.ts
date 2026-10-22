/**
 * The snapshot retention sweep on a browser's own IndexedDB (command-bus §5.1). `packages/store/test/snapshot-retention.test.ts`
 * pins the rules and the one-transaction atomicity against the repo's in-memory IndexedDB; this spec runs `evictSnapshots` against
 * the page's real one, so the claim "eviction works on IndexedDB" is checked and not modelled.
 *
 * The store's own functions are imported into the page from the dev server (the app's `indexedDB`, `openRuntimeStore`,
 * `writeBodySnapshot`, `readBodySnapshots`, `evictSnapshots`). Each test has a fresh browser context, so its database starts empty.
 */

import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import type * as Store from '../packages/store/src/index.js';
import { createProject } from './support.js';

/** Where the dev server serves the store's source from: Vite's `/@fs/` prefix over the absolute path, same origin as the app. */
const STORE_URL = `/@fs/${fileURLToPath(new URL('../packages/store/src/index.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

/** One snapshot to write, with its age in days instead of a timestamp. */
interface Seed {
  readonly projectId: string;
  readonly docId: string;
  readonly revision: number;
  readonly ageDays: number;
}

/** `docId@revision` of the rows, in the order given, for a readable assertion. */
type Keyed = readonly string[];

interface Swept {
  readonly evict: Keyed;
  readonly retain: Keyed;
  readonly expired: Keyed;
  readonly overCap: Keyed;
  readonly pinned: Keyed;
  readonly orphans: Keyed;
  readonly capMet: boolean;
}

/** The store module's functions the page-side callbacks use, typed through the real module so a rename fails the typecheck. */
type StoreModule = typeof Store;

/** Writes the seeded rows through the store's own `writeBodySnapshot`, in the app's `caotang` database. */
async function seed(page: Page, rows: readonly Seed[]): Promise<void> {
  await page.evaluate(
    async ({ url, rows: seeds, now }) => {
      const store = (await import(/* @vite-ignore */ url)) as StoreModule;
      const runtime = await store.openRuntimeStore(indexedDB);
      try {
        for (const row of seeds) {
          await store.writeBodySnapshot(runtime, {
            projectId: row.projectId,
            docId: row.docId,
            revision: row.revision,
            body: `${row.docId} revision ${row.revision}`,
            capturedAt: now - row.ageDays * 86_400_000,
            command: 'e2e.seed',
          });
        }
      } finally {
        runtime.close();
      }
    },
    { url: STORE_URL, rows, now: Date.now() },
  );
}

/** The project's rows as `docId@revision`, read through the store in a fresh read transaction. */
async function stored(page: Page, projectId: string): Promise<string[]> {
  return page.evaluate(
    async ({ url, project }) => {
      const store = (await import(/* @vite-ignore */ url)) as StoreModule;
      const runtime = await store.openRuntimeStore(indexedDB);
      try {
        return (await store.readBodySnapshots(runtime, project)).map((row) => `${row.docId}@${row.revision}`);
      } finally {
        runtime.close();
      }
    },
    { url: STORE_URL, project: projectId },
  );
}

/** Runs `evictSnapshots` in the page with the given limits, and reports the plan it returned by row keys. */
async function sweep(page: Page, projectId: string, config: { checkpointCap: number; checkpointDays: number }): Promise<Swept> {
  return page.evaluate(
    async ({ url, project, limits }) => {
      const store = (await import(/* @vite-ignore */ url)) as StoreModule;
      const runtime = await store.openRuntimeStore(indexedDB);
      try {
        const plan = await store.evictSnapshots(runtime, project, Date.now(), limits);
        const keys = (rows: readonly { docId: string; revision: number }[]): string[] => rows.map((row) => `${row.docId}@${row.revision}`);
        return {
          evict: keys(plan.evict),
          retain: keys(plan.retain),
          expired: keys(plan.expired),
          overCap: keys(plan.overCap),
          pinned: keys(plan.pinned),
          orphans: keys(plan.orphans),
          capMet: plan.capMet,
        };
      } finally {
        runtime.close();
      }
    },
    { url: STORE_URL, project: projectId, limits: config },
  );
}

/**
 * Rows for the cases below, with a cap of 2 and a window of 30 days:
 *   a@1 40 days old is a's first snapshot and a has later ones, so it is pinned and survives its age;
 *   a@2 35 days old is past the window; c@1 60 days old is c's only row, so nothing pins it;
 *   of the four inside the window and not pinned (d@1 4 days, a@3 3, a@4 2, a@5 1) the cap keeps the newest, a@5.
 */
const LADDER: readonly Seed[] = [
  { projectId: 'p_ladder', docId: 'a', revision: 1, ageDays: 40 },
  { projectId: 'p_ladder', docId: 'a', revision: 2, ageDays: 35 },
  { projectId: 'p_ladder', docId: 'a', revision: 3, ageDays: 3 },
  { projectId: 'p_ladder', docId: 'a', revision: 4, ageDays: 2 },
  { projectId: 'p_ladder', docId: 'a', revision: 5, ageDays: 1 },
  { projectId: 'p_ladder', docId: 'c', revision: 1, ageDays: 60 },
  { projectId: 'p_ladder', docId: 'd', revision: 1, ageDays: 4 },
];
const LIMITS = { checkpointCap: 2, checkpointDays: 30 } as const;
const ALL_ROWS = ['a@1', 'a@2', 'a@3', 'a@4', 'a@5', 'c@1', 'd@1'];

test('the sweep on the browser’s IndexedDB keeps the pin and the newest rows, reports its plan, and a second sweep deletes nothing', async ({ page }) => {
  await page.goto('/');
  await seed(page, [...LADDER, { projectId: 'p_other', docId: 'a', revision: 1, ageDays: 400 }]);
  expect(await stored(page, 'p_ladder')).toEqual(ALL_ROWS);

  const plan = await sweep(page, 'p_ladder', LIMITS);

  expect(plan.expired).toEqual(['c@1', 'a@2']);
  expect(plan.overCap).toEqual(['d@1', 'a@3', 'a@4']);
  expect(plan.pinned).toEqual(['a@1']);
  expect(plan.retain).toEqual(['a@1', 'a@5']);
  expect([...plan.evict].sort()).toEqual(['a@2', 'a@3', 'a@4', 'c@1', 'd@1']);
  // Each stored row is its own last reference, so the orphans are exactly the evicted rows (retention.ts header).
  expect(plan.orphans).toEqual(plan.evict);
  expect(plan.capMet).toBe(true);
  // What the plan says is what the database holds, and another project's old row is not touched.
  expect(await stored(page, 'p_ladder')).toEqual(['a@1', 'a@5']);
  expect(await stored(page, 'p_other')).toEqual(['a@1']);

  const again = await sweep(page, 'p_ladder', LIMITS);
  expect(again.evict).toEqual([]);
  expect(again.retain).toEqual(['a@1', 'a@5']);
  expect(await stored(page, 'p_ladder')).toEqual(['a@1', 'a@5']);
});

test('a transaction that aborts part-way through the sweep leaves every row in place and the sweep rejects', async ({ page }) => {
  await page.goto('/');
  await seed(page, LADDER);

  const outcome = await page.evaluate(
    async ({ url, project, limits }) => {
      const store = (await import(/* @vite-ignore */ url)) as StoreModule;
      const runtime = await store.openRuntimeStore(indexedDB);
      // The browser aborts the sweep's transaction on its second delete, after the first has been queued in it: the real
      // transaction's rollback is what is under test, so the abort is the browser's own `IDBTransaction.abort()`.
      const original = IDBObjectStore.prototype.delete;
      let deletes = 0;
      IDBObjectStore.prototype.delete = function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
        deletes += 1;
        if (deletes < 2) return original.apply(this, args);
        if (deletes === 2) this.transaction.abort();
        return undefined as unknown as IDBRequest<undefined>;
      };
      try {
        await store.evictSnapshots(runtime, project, Date.now(), limits);
        return { rejected: false, message: '', deletes };
      } catch (error) {
        return { rejected: true, message: error instanceof Error ? error.message : String(error), deletes };
      } finally {
        IDBObjectStore.prototype.delete = original;
        runtime.close();
      }
    },
    { url: STORE_URL, project: 'p_ladder', limits: LIMITS },
  );

  expect(outcome.rejected).toBe(true);
  // The first delete was queued before the abort; the rollback is what took it back.
  expect(outcome.deletes).toBeGreaterThanOrEqual(2);
  expect(await stored(page, 'p_ladder')).toEqual(ALL_ROWS);

  // And the sweep still works afterwards, so the abort left no transaction or lock behind.
  expect((await sweep(page, 'p_ladder', LIMITS)).evict).toHaveLength(5);
  expect(await stored(page, 'p_ladder')).toEqual(['a@1', 'a@5']);
});

test('Settings › Data › Trim to the limits now reduces the open project’s stored checkpoints to the retained set', async ({ page }) => {
  await createProject(page);
  const projectId = await page.evaluate(() => (globalThis as unknown as { __caotang: { projectId(): string | null } }).__caotang.projectId());
  expect(projectId).not.toBeNull();
  // The default limits apply (100 checkpoints, 30 days), so these rows are cut by age alone: a@1 is pinned, a@2 and c@1 are past 30 days.
  await seed(page, [
    { projectId: projectId!, docId: 'e2e-a', revision: 1, ageDays: 60 },
    { projectId: projectId!, docId: 'e2e-a', revision: 2, ageDays: 50 },
    { projectId: projectId!, docId: 'e2e-a', revision: 3, ageDays: 1 },
    { projectId: projectId!, docId: 'e2e-c', revision: 1, ageDays: 70 },
  ]);
  const before = await stored(page, projectId!);
  expect(before).toEqual(expect.arrayContaining(['e2e-a@1', 'e2e-a@2', 'e2e-a@3', 'e2e-c@1']));

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Data' }).click();
  const budget = settings.getByTestId('snapshot-budget');
  await expect(budget).toContainText(`${before.length} checkpoints`);

  await settings.getByRole('button', { name: 'Trim to the limits now' }).click();
  await expect(settings.getByText('Trimmed to the limits.')).toBeVisible();

  const after = await stored(page, projectId!);
  expect(after).toEqual(before.filter((key) => key !== 'e2e-a@2' && key !== 'e2e-c@1'));
  expect(after).toEqual(expect.arrayContaining(['e2e-a@1', 'e2e-a@3']));
  await expect(budget).toContainText(`${after.length} ${after.length === 1 ? 'checkpoint' : 'checkpoints'}`);
});
