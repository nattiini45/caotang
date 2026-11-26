// @vitest-environment jsdom

/**
 * The account's copy of a hosted project, as the writer is told about it (hosted.md §7, §11): a save the server did not take
 * says the account is behind; a save another device committed first asks the "files changed" question and names the documents
 * by their titles rather than their file names; and both answers work — keep this device's text, or leave it for now.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ProjectSession } from '../src/app/session.js';
import { HostedSaveNotice } from '../src/components/HostedSaveNotice.js';
import { HostedTarget, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
import { forgetHostedTarget, installHostedTarget } from '../src/app/hosted-target-registry.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const DOC = 'n_LIGHTHOUSE';
const PATH = `docs/${DOC}.md`;

let root: Root;
let host: HTMLDivElement;
let state: ProjectState;
let session: ProjectSession;
let sends: boolean[];
const accepted: HostedReplay = { kind: 'accepted', changes: [] };
const conflict: HostedReplay = { kind: 'conflict', versions: new Map([[PATH, 2]]) };
const unavailable: HostedReplay = { kind: 'unavailable' };

function target(answers: HostedReplay[] = [accepted], held: readonly string[] = [], durable = true, failStage = false): HostedTarget {
  const paths = new Set(held);
  const queue: HostedQueuePort = {
    held: () => [...paths],
    deferred: () => [],
    opened: () => undefined,
    persisted: () => durable,
    stage: (changes) => {
      if (failStage) {
        failStage = false;
        throw new Error('This tab could not prepare the files');
      }
      for (const change of changes) paths.add(change.path);
    },
    send: async (refresh) => {
      sends.push(refresh);
      const result = answers.shift() ?? unavailable;
      if (result.kind === 'accepted') paths.clear();
      return result;
    },
  };
  return new HostedTarget('p_lighthouse', {} as never, queue, async () => ({
    changes: async () => [{ path: PATH, base: 1, bytes: new Uint8Array([1]) }],
    accepted: () => undefined,
  }));
}

async function render(one: HostedTarget, onReopenAccount?: () => void): Promise<void> {
  await one.rememberOpened(state, {});
  installHostedTarget(one);
  await act(async () => root.render(
    <I18nProvider i18n={i18n}><HostedSaveNotice session={session} onReopenAccount={onReopenAccount} /></I18nProvider>,
  ));
}

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  sends = [];
  state = createProjectState(createEmptyManifest('The lighthouse', new Date(0)));
  addDocument(state, { parentId: 'manuscript', id: DOC, title: 'The lamp goes out', body: 'The lamp went out.', now: new Date(0) });
  session = { projectId: 'p_lighthouse', state } as unknown as ProjectSession;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  forgetHostedTarget('p_lighthouse');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Everything the notice shows: a status line in the workspace, and the question, which the app's dialog renders in the body. */
function shown(): string {
  return document.body.textContent ?? '';
}

/** The button labelled `label`, which is how the writer reaches every answer here. */
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button labelled ${label}: ${shown()}`);
  return found;
}

it('says nothing while a save is idle', async () => {
  await render(target());
  expect(host.innerHTML).toBe('');
});

it('says the changes are on this device when the server does not take the save, and sends them only when asked', async () => {
  const one = target([unavailable, accepted]);
  await render(one);
  await act(async () => one.save(state));
  expect(shown()).toContain('Saved here, not to your account.');
  expect(sends).toEqual([false]);
  await act(async () => button('Send them to your account').click());
  expect(sends).toEqual([false, true]);
});

it('says the words are only in this tab when the queue could not be written, and still offers the send', async () => {
  const one = target([unavailable], [], false);
  await render(one);
  await act(async () => one.save(state));
  expect(shown()).toContain('Closing this tab loses these changes.');
  expect(shown()).not.toContain('Saved here, not to your account.');
  expect(button('Send them to your account')).toBeTruthy();
});

it('names the documents another device changed by their titles, never by their file names', async () => {
  const one = target([conflict]);
  await render(one);
  await act(async () => one.save(state));
  expect(shown()).toContain('Another device saved these first');
  expect(shown()).toContain('The lamp goes out');
  expect(shown()).not.toContain(PATH);
});

it('keeps this device’s text when the writer says so, and the question goes', async () => {
  const reopen = vi.fn();
  const one = target([conflict, accepted]);
  await render(one, reopen);
  await act(async () => one.save(state));
  await act(async () => button('Keep this device’s text').click());
  expect(shown()).not.toContain('Another device saved these first');
  expect(reopen).not.toHaveBeenCalled();
  expect(button('Read them')).toBeTruthy();
});

it('leaves it for now, and holds that answer until the writer asks again', async () => {
  const one = target([conflict]);
  await render(one);
  await act(async () => one.save(state));
  await act(async () => button('Leave it for now').click());
  expect(shown()).toContain('Saved here, not to your account.');
  expect(sends).toEqual([false]);
  await act(async () => button('Ask me again').click());
  expect(shown()).toContain('Another device saved these first');
});

it('offers to read the account after an explicit send without reopening automatically', async () => {
  const reopen = vi.fn();
  await render(target([accepted], [PATH]), reopen);
  await act(async () => button('Send them to your account').click());
  expect(reopen).not.toHaveBeenCalled();
  await act(async () => button('Read them').click());
  expect(reopen).toHaveBeenCalledOnce();
});

it('keeps the read action available when further edits were durably staged', async () => {
  const reopen = vi.fn();
  const one = target([accepted], [PATH]);
  await render(one, reopen);
  await act(async () => button('Send them to your account').click());
  await act(async () => one.save(state));
  expect(one.canReread()).toBe(true);
  expect(button('Send them to your account')).toBeTruthy();
  await act(async () => button('Read them').click());
  expect(reopen).toHaveBeenCalledOnce();
  expect(sends).toEqual([true]);
});

it.each([{ held: [] }, { held: [PATH] }])('offers a local retry after staging fails ($held)', async ({ held }) => {
  const one = target([accepted], held, true, true);
  await render(one);
  await act(async () => one.save(state));
  expect(one.state()).toMatchObject({ kind: 'unsaved', persisted: true, stageFailed: true });
  expect(shown()).toContain('Your latest edits aren’t ready to send.');
  expect(shown()).not.toContain('Send them to your account');
  expect(shown()).not.toContain('Closing this tab loses these changes.');
  await act(async () => button('Try again').click());
  expect(button('Send them to your account')).toBeTruthy();
  expect(sends).toEqual([]);
});
