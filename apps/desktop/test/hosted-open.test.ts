/**
 * What a hosted open does with the browser's own copy of the account's project (hosted.md §7, §11). The account is the project's
 * home, so opening it again is the same project rather than a second copy of itself whose id the next save would write into the
 * account's manifest.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryArtifactFs, MemoryIndexedDb, openRuntimeStore, writeProject, type RuntimeStore } from '@caotang/store';

import { openHostedProject, type Opened } from '../src/app/lifecycle.js';
import { forgetHostedTarget, HostedTarget } from '../src/app/hosted-target.js';
import type { HostedProjectSource } from '../src/app/studio-host.js';
import { IDS, project } from '../../../e2e/unit/fixtures.js';

/** One project for the whole file: a fixture built twice makes a second project id, and these tests are about one project. */
const BOOK = project();

const SOURCE: HostedProjectSource = {
  projectId: 'p_fixture',
  origin: 'https://studio.example',
  device: 'tab_one',
  key: {} as never,
};

let store: RuntimeStore;
let opened: Opened[];

beforeEach(async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  store = await openRuntimeStore(new MemoryIndexedDb());
  opened = [];
});

afterEach(async () => {
  for (const one of opened) await one.session.closeSafely();
  forgetHostedTarget(SOURCE.projectId);
  store.close();
  vi.unstubAllGlobals();
});

async function targetFor(): Promise<HostedTarget> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, BOOK);
  return new HostedTarget(
    SOURCE.projectId,
    fs as never,
    (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never,
  );
}

/** Opens through the lifecycle, closing whatever it opened when the test ends. */
async function open(): Promise<Opened> {
  const target = await targetFor();
  const result = await openHostedProject(store, SOURCE, async () => target);
  opened.push(result);
  return result;
}

it('opens the account’s project under its own id', async () => {
  const first = await open();
  expect(first.session.projectId).toBe(BOOK.manifest.project.id);
  expect(first.copiedFrom).toBeNull();
  expect(first.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
});

it('opens the same project again under its own id, not as a copy of itself', async () => {
  const first = await open();
  expect(first.copiedFrom).toBeNull();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  const second = await open();
  expect(second.session.projectId).toBe(BOOK.manifest.project.id);
  expect(second.copiedFrom).toBeNull();
});
