/**
 * Helpers shared by the Playwright suites. Not a spec file: it is imported, never run.
 *
 * The suites read the app through its gestures and through `window.__caotang` (the DEV-only
 * hook in apps/desktop/src/app/test-hook.ts). The hook is read-only, so every assertion
 * about state is an assertion about what the app did, not about what a test poked in.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** Why a spec that opens or saves a project folder skips outside Chromium: Firefox and WebKit have no folder picker, so a writer there uses bundles. */
export const FOLDER_ACCESS_ONLY = 'File System Access is Chromium-only';

/** One row of the activity log, as the hook reports it. */
export interface TraceRow {
  readonly command: string;
  readonly issuedBy: 'user' | 'agent';
  readonly summary: string;
  readonly affected: readonly { readonly nodeId: string; readonly title: string }[];
  readonly undoGroupId: string | null;
}

/*
 * The hook is read inside `page.evaluate` callbacks, which are serialised and run in the
 * browser. Each callback types the one method it uses through `globalThis`, because this
 * package's tsconfig has no DOM lib: in the browser `globalThis` is `window`.
 */

/**
 * The chapter a test makes a media node in, when it asks for one "under the manuscript": the binder offers the media entries on chapters
 * only. It is the manuscript's "Chapter 1", made with the empty manuscript's button when
 * there is none yet.
 */
export async function firstChapter(page: Page): Promise<string> {
  const chapter = binderTitle(page, 'Chapter 1');
  if ((await chapter.count()) === 0) {
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    await expect(chapter).toBeVisible();
  }
  return 'Chapter 1';
}

/** Create a project from the projects screen and wait for the writing shell. */
export async function createProject(page: Page, name = 'The Lighthouse Keeper'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await waitForSaved(page);
}

/** The binder row for a title. Rows are `treeitem`s, and the title is the row's text. */
export function binderRow(page: Page, title: string): Locator {
  return page.locator('.row', { has: page.locator('.row-title', { hasText: exactly(title) }) }).first();
}

/**
 * The title of a binder row. A click on a document's title selects it; the row's centre can
 * fall on the status chip, which opens the picker by design, so tests click the title.
 */
export function binderTitle(page: Page, title: string): Locator {
  return binderRow(page, title).locator('.row-title');
}

/** The corkboard card for a title. */
export function card(page: Page, title: string): Locator {
  return page.locator('article.card', { has: page.getByRole('heading', { name: title, exact: true }) });
}

/** Match a text exactly, so "Chapter 1" does not also match "Chapter 10". */
function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** Every activity row, in order. */
export async function trace(page: Page): Promise<TraceRow[]> {
  return page.evaluate(() => {
    const caotang = (globalThis as unknown as { __caotang?: { activity(): unknown[] } }).__caotang;
    return (caotang?.activity() ?? []) as TraceRow[];
  });
}

/** Only the names, in order — the shape the trace assertions compare. */
export async function traceNames(page: Page): Promise<string[]> {
  return (await trace(page)).map((row) => row.command);
}

/** How many activity rows a command has: the number of times it actually ran. */
export async function countOf(page: Page, command: string): Promise<number> {
  return (await traceNames(page)).filter((name) => name === command).length;
}

/** One dispatch the bus turned away, as the hook reports it. */
export interface RejectedRow {
  readonly command: string;
  readonly issuedBy: 'user' | 'agent';
  readonly code: string;
}

/**
 * Every dispatch the bus turned away, in order. A refused command writes no activity row (command-bus
 * §8: one entry per executed command), so `trace` cannot show one: a test that must rule a command out
 * reads this as well.
 */
export async function rejected(page: Page): Promise<RejectedRow[]> {
  return page.evaluate(() => {
    const caotang = (globalThis as unknown as { __caotang?: { rejected(): RejectedRow[] } }).__caotang;
    return caotang?.rejected() ?? [];
  });
}

/**
 * Stop the page's clock a second from now, so the test decides when time passes. The clock must already
 * be installed (`page.clock.install()`, before the page loads); after this, a timer fires only when the
 * test runs the clock forward with `page.clock.runFor`. That is how the debounce is measured exactly.
 */
export async function freezeClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
}

/** The command names with the view events removed: what changed the project. */
export async function projectTrace(page: Page): Promise<string[]> {
  return (await traceNames(page)).filter((name) => !name.startsWith('view.'));
}

/** The open project's id, from the hook. */
export async function projectIdOf(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const caotang = (globalThis as unknown as { __caotang?: { projectId(): string | null } }).__caotang;
    return caotang?.projectId() ?? null;
  });
}

/** The shell's save indicator reads "saved": every change has reached the browser store. */
export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

/** Read a document's body through the hook. */
export async function bodyOf(page: Page, docId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const caotang = (globalThis as unknown as { __caotang?: { body(docId: string): string | null } }).__caotang;
    return caotang?.body(id) ?? null;
  }, docId);
}

/** The node id for a title, read from the hook's tree. */
export async function idOf(page: Page, title: string): Promise<string> {
  const id = await page.evaluate((wanted) => {
    const caotang = (globalThis as unknown as {
      __caotang?: { tree(): { id: string; title: string }[] };
    }).__caotang;
    return caotang?.tree().find((node) => node.title === wanted)?.id ?? null;
  }, title);
  if (id === null) throw new Error(`no node titled "${title}"`);
  return id;
}

/** The project's tree, as the hook reports it. */
export async function treeOf(page: Page): Promise<{ id: string; parentId: string | null; type: string; title: string }[]> {
  return page.evaluate(() => {
    const caotang = (globalThis as unknown as {
      __caotang?: { tree(): { id: string; parentId: string | null; type: string; title: string }[] };
    }).__caotang;
    return caotang?.tree() ?? [];
  });
}

/** Whether a title exists anywhere in the project tree. */
export async function hasTitle(page: Page, title: string): Promise<boolean> {
  return (await treeOf(page)).some((node) => node.title === title);
}

/** The range the shown editor has selected, as body offsets in its document, or `null` when nothing is selected. */
export async function selectionOf(page: Page): Promise<{ docId: string; from: number; to: number } | null> {
  return page.evaluate(() => {
    const caotang = (globalThis as unknown as {
      __caotang?: { selection(): { docId: string; from: number; to: number } | null };
    }).__caotang;
    return caotang?.selection() ?? null;
  });
}
