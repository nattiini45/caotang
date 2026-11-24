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
import { forgetHostedTarget, HostedTarget, rememberHostedTarget, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const DOC = 'n_LIGHTHOUSE';
const PATH = `docs/${DOC}.md`;

let root: Root;
let host: HTMLDivElement;
let state: ProjectState;
let session: ProjectSession;
let committed: unknown[][];

function target(outcome: unknown, queue: HostedQueuePort | null = null): HostedTarget {
  const fs = {
    refresh: async () => undefined,
    commitChanges: async (changes: unknown[]) => {
      committed.push(changes);
    },
  };
  return new HostedTarget('p_lighthouse', fs as never, (async () => outcome) as never, queue);
}

/** A queue an earlier tab left: it holds `held`, and a replay answers `answer`. */
function queue(held: readonly string[], answer: HostedReplay | readonly HostedReplay[] = { kind: 'sent', count: 1 }): HostedQueuePort {
  const paths = new Set(held);
  const answers = Array.isArray(answer) ? [...answer] : null;
  return {
    hold: () => undefined,
    replay: async () => (answers === null ? (answer as HostedReplay) : (answers.shift() ?? { kind: 'conflict', paths: [...paths] })),
    forget: (forgotten?: readonly string[]) => {
      if (forgotten === undefined) paths.clear();
      else for (const path of forgotten) paths.delete(path);
    },
    rebase: () => undefined,
    held: () => [...paths],
    marks: () => undefined,
  };
}

async function render(one: HostedTarget, onReopenAccount?: () => void): Promise<void> {
  rememberHostedTarget(one);
  await act(async () => root.render(
    <I18nProvider i18n={i18n}><HostedSaveNotice session={session} onReopenAccount={onReopenAccount} /></I18nProvider>,
  ));
}

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  committed = [];
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
  await render(target({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }));
  expect(host.innerHTML).toBe('');
});

it('says the changes are on this device when the server does not take the save, and sends them only when asked', async () => {
  const one = target({ kind: 'unavailable', changes: [] });
  await render(one);
  await act(async () => one.save(state));
  expect(shown()).toContain('These changes are on this device.');
  expect(button('Send them to your account')).toBeTruthy();
  // Nothing has been sent: the button is the writer's choice, not an automatic retry.
  expect(committed.length).toBe(0);
});

it('names the documents another device changed by their titles, never by their file names', async () => {
  const one = target({ kind: 'conflict', paths: [PATH], changes: [{ path: PATH, kind: 'modified' }] });
  await render(one);
  await act(async () => one.save(state));
  expect(shown()).toContain('Another device saved these first');
  expect(shown()).toContain('The lamp goes out');
  expect(shown()).not.toContain(PATH);
});

it('keeps this device’s text when the writer says so, and the question goes', async () => {
  // The first save loses to another device; the whole save run again on top of their version lands.
  const outcomes = [
    { kind: 'conflict', paths: [PATH], changes: [{ path: PATH, kind: 'modified' }] },
    { kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } },
  ];
  const one = new HostedTarget('p_lighthouse', { refresh: async () => undefined } as never, (async () => outcomes.shift()) as never);
  await render(one);
  await act(async () => one.save(state));
  await act(async () => button('Keep this device’s text').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(shown()).not.toContain('Another device saved these first');
  expect(host.innerHTML).toBe('');
});

it('leaves it for now, and holds that answer until the writer asks again', async () => {
  const one = target({ kind: 'conflict', paths: [PATH], changes: [{ path: PATH, kind: 'modified' }] });
  await render(one);
  await act(async () => one.save(state));
  await act(async () => button('Leave it for now').click());
  expect(shown()).toContain('Your account keeps the other device’s version.');
  expect(committed).toEqual([]);
  await act(async () => button('Ask me again').click());
  expect(shown()).toContain('Another device saved these first');
});

it('reads the account again once a send the writer chose puts words on it', async () => {
  const reopen = vi.fn();
  const one = target({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } }, queue([PATH]));
  await render(one, reopen);
  // The open found words the account does not have: they are here, and the writer sends them.
  await act(async () => one.heldAtOpen());
  await act(async () => button('Send them to your account').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(reopen).toHaveBeenCalledOnce();
});

it('leaves the open book alone when this session’s own save conflicted, because its text is what was read', async () => {
  const reopen = vi.fn();
  const one = target({ kind: 'conflict', paths: [PATH], changes: [{ path: PATH, kind: 'modified' }] });
  await render(one, reopen);
  await act(async () => one.save(state));
  await act(async () => button('Keep this device’s text').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(reopen).not.toHaveBeenCalled();
});
