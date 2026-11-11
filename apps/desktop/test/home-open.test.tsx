// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { createEmptyManifest, createProjectState, MemoryArtifactFs, type RuntimeStore } from '@caotang/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Home } from '../src/components/Home.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import type { AppServices } from '../src/app/services.js';
import type { DirectoryHandleLike } from '../src/app/fs-access.js';
import { pickDirectory } from '../src/app/fs-access.js';
import { rememberedFolder } from '../src/app/folder-memory.js';
import {
  answerFolderDiffers, completeEncodingReview, completeRecovery, createProject, importBundle, listProjects, openFolder, openProject,
  type FolderDiffers, type Opened, type OpenOutcome, type PendingEncoding, type PendingRecovery,
} from '../src/app/lifecycle.js';

vi.mock('../src/app/lifecycle.js', () => ({
  answerFolderDiffers: vi.fn(), completeEncodingReview: vi.fn(), completeRecovery: vi.fn(), createProject: vi.fn(),
  exportStoredBundle: vi.fn(), imageDropNotice: () => [], hookNotice: () => [], importBundle: vi.fn(), listProjects: vi.fn(),
  openFolder: vi.fn(), openElsewhere: vi.fn(), openProject: vi.fn(), peekLeaveSuggestion: () => null,
  removeProject: vi.fn(), takeLeaveSuggestion: vi.fn(),
}));
vi.mock('../src/app/fs-access.js', () => ({ folderAccessSupported: () => true, pickDirectory: vi.fn() }));
vi.mock('../src/app/folder-memory.js', () => ({ rememberedFolder: vi.fn(), folderWithPermission: vi.fn() }));
vi.mock('../src/components/LazySettings.js', () => ({ Settings: () => null }));

const state = createProjectState(createEmptyManifest('Harbour', new Date('2026-11-11T19:00:00Z'), { locale: 'en-US' }));
const fs = new MemoryArtifactFs();
const folder = { name: 'Harbour folder', kind: 'directory' } as DirectoryHandleLike;
const recovery: PendingRecovery = {
  name: 'Harbour folder', fs, sessions: [], folder, digests: new Map(),
  offer: {
    state, source: { kind: 'snapshot', path: 'caotang.json.bak.1', generation: 1 }, recovered: true, requiresConsent: false,
    loss: [], notices: [], encodingIssues: [], recoveredDocuments: [], recoveredCodex: [],
  },
};
const encoding: PendingEncoding = {
  name: 'Legacy bundle', fs, issues: [], cancelNote: '',
  resume: { kind: 'bundle', sessions: [], assets: {}, coherence: undefined, tasks: undefined },
};
const differs: FolderDiffers = {
  projectId: state.manifest.project.id, projectName: 'Harbour', folderName: folder.name, root: folder, state,
  folderLog: [], notices: [], droppedFields: [], pictures: {}, baselineText: '{}', digests: new Map(),
};
const opened = { session: {}, notices: [], droppedFields: [], copiedFrom: null } as Opened;
const store = {} as RuntimeStore;
const services = {
  settings: { current: () => DEFAULT_SETTINGS, subscribe: () => () => undefined },
  providers: { resolveForRole: () => undefined },
} as unknown as AppServices;

let root: Root;
let host: HTMLDivElement;
let onOpened: ReturnType<typeof vi.fn>;
let onRunDemo: ReturnType<typeof vi.fn>;

function render(demoOpening = false): void {
  root.render(<I18nProvider i18n={i18n}><Home store={store} services={services} onOpened={onOpened} onRunDemo={onRunDemo} demoOpening={demoOpening} notices={[]} /></I18nProvider>);
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text && (candidate.closest('dialog')?.open ?? true));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function demoButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[aria-label="Demo intents"] button')!;
}

function phase(): string | null {
  return host.querySelector('.home')?.getAttribute('data-state') ?? null;
}

async function offer(outcome: OpenOutcome): Promise<void> {
  vi.mocked(openFolder).mockResolvedValueOnce(outcome);
  await act(async () => button('Open a folder…').click());
}

function submit(): void {
  host.querySelector('form.new-project')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  vi.mocked(listProjects).mockResolvedValue([{ id: state.manifest.project.id, name: 'Harbour', documents: 1, words: 3 }]);
  vi.mocked(pickDirectory).mockResolvedValue(folder);
  vi.mocked(rememberedFolder).mockResolvedValue(folder);
  onOpened = vi.fn();
  onRunDemo = vi.fn();
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  root = createRoot(host);
  await act(async () => render());
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.unstubAllGlobals();
});

describe('Home open ownership', () => {
  it('guards a same-tick form resubmit and competing open or demo before disabled UI renders', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(createProject).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => {
      submit();
      submit();
      button('Open').click();
      button('Open a folder…').click();
      demoButton().click();
    });
    expect(createProject).toHaveBeenCalledOnce();
    expect(openProject).not.toHaveBeenCalled();
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(onRunDemo).not.toHaveBeenCalled();
    expect(button('Create project').getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('.is-opening')).toHaveLength(1);
    await act(async () => reject(new Error('Disk unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Creating the project did not finish: Disk unavailable');
    vi.mocked(createProject).mockResolvedValueOnce(opened.session);
    await act(async () => submit());
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it('disables all entry points during demo opening and guards programmatic submit and file change', async () => {
    await act(async () => render(true));
    expect(phase()).toBe('idle');
    expect(host.querySelector('.home')?.getAttribute('data-demo-state')).toBe('opening');
    for (const text of ['Create project', 'Open', 'Reopen folder', 'Open a folder…', 'Import bundle (.caotang)']) expect(button(text).disabled, text).toBe(true);
    expect(demoButton().disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Opening the project…');
    const input = host.querySelector<HTMLInputElement>('[data-testid="bundle-input"]')!;
    expect(input.disabled).toBe(true);
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([], 'sample.caotang')] });
    await act(async () => {
      submit();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      demoButton().click();
    });
    expect(createProject).not.toHaveBeenCalled();
    expect(importBundle).not.toHaveBeenCalled();
    expect(onRunDemo).not.toHaveBeenCalled();
  });

  it('guards a demo request synchronously until its promise settles, without a prop-render handshake', async () => {
    let finish!: () => void;
    onRunDemo.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    await act(async () => {
      demoButton().click();
      submit();
      demoButton().click();
    });
    expect(onRunDemo).toHaveBeenCalledOnce();
    expect(createProject).not.toHaveBeenCalled();
    expect(host.querySelector('.home')?.getAttribute('data-demo-state')).toBe('opening');
    expect(demoButton().disabled).toBe(true);
    expect(demoButton().getAttribute('aria-busy')).toBe('true');
    expect(demoButton().classList.contains('is-opening')).toBe(true);
    expect(host.querySelectorAll('.is-opening')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.classList.contains('visually-hidden')).toBe(true);
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    await act(async () => finish());
    expect(host.querySelector('.home')?.getAttribute('data-demo-state')).toBe('idle');
    expect(host.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
    vi.mocked(createProject).mockResolvedValueOnce(opened.session);
    await act(async () => submit());
    expect(createProject).toHaveBeenCalledOnce();
  });

  it('releases an immediately rejected demo even when no opening prop is rendered', async () => {
    onRunDemo.mockRejectedValueOnce(new Error('Sample unavailable'));
    await act(async () => demoButton().click());
    expect(host.querySelector('.home')?.getAttribute('data-demo-state')).toBe('idle');
    expect(demoButton().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Opening the project did not finish: Sample unavailable');
    vi.mocked(createProject).mockResolvedValueOnce(opened.session);
    await act(async () => submit());
    expect(createProject).toHaveBeenCalledOnce();
  });

  it('marks the pressed project control, preserves its label, and clears progress after failure', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(openProject).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => button('Open').click());
    expect(button('Open').getAttribute('aria-busy')).toBe('true');
    expect(button('Open').classList.contains('is-opening')).toBe(true);
    expect(host.querySelectorAll('.is-opening')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.classList.contains('visually-hidden')).toBe(true);
    await act(async () => fail(new Error('Project unavailable')));
    expect(button('Open').hasAttribute('aria-busy')).toBe(false);
    expect(button('Open').classList.contains('is-opening')).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Project unavailable');
  });
});

describe('Home pending-open dialogs', () => {
  it('retains the visible busy sentence when a recovery has no inline Home control', async () => {
    await offer({ kind: 'recover', recovery });
    let finish!: () => void;
    vi.mocked(completeRecovery).mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({ kind: 'opened', opened }); }));
    await act(async () => button('Open this copy').click());
    expect(host.querySelector('[role="status"]')?.classList.contains('visually-hidden')).toBe(false);
    await act(async () => finish());
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(opened);
  });

  it('keeps a locked recovery visible, confirms the retry and hands off to encoding alone', async () => {
    await offer({ kind: 'recover', recovery });
    expect(phase()).toBe('recovery');
    vi.mocked(completeRecovery).mockResolvedValueOnce({ kind: 'refused', reason: 'locked', files: [] });
    await act(async () => button('Open this copy').click());
    expect(completeRecovery).toHaveBeenLastCalledWith(store, recovery, {});
    expect(phase()).toBe('recovery');
    expect(host.querySelector('[data-testid="recovery-dialog"] [role="alert"]')?.textContent).toContain('Go ahead anyway?');
    const recoveredEncoding = { ...encoding, cancelNote: 'The recovered manifest was written.' };
    vi.mocked(completeRecovery).mockResolvedValueOnce({ kind: 'encoding', encoding: recoveredEncoding });
    await act(async () => button('Open this copy anyway').click());
    expect(completeRecovery).toHaveBeenLastCalledWith(store, recovery, { lockConfirmed: true });
    expect(phase()).toBe('encoding');
    expect(host.querySelector('[data-testid="recovery-dialog"]')).toBeNull();
    await act(async () => button('Cancel').click());
    expect(phase()).toBe('idle');
    expect(host.textContent).toContain(recoveredEncoding.cancelNote);
    expect(onOpened).not.toHaveBeenCalled();
  });

  for (const reason of ['changed', 'files'] as const) {
    it(`keeps a ${reason} refusal close-only and does not leak it into a later recovery`, async () => {
      await offer({ kind: 'recover', recovery });
      vi.mocked(completeRecovery).mockResolvedValueOnce({ kind: 'refused', reason, files: [{ change: 'changed', label: 'Harbour scene' }] });
      await act(async () => button('Open this copy').click());
      const dialog = host.querySelector('[data-testid="recovery-dialog"]')!;
      expect([...dialog.querySelectorAll('button')].map((item) => item.textContent)).toEqual(['Close']);
      if (reason === 'files') expect(dialog.textContent).toContain('Harbour scene');
      await act(async () => button('Close').click());
      expect(phase()).toBe('idle');
      expect(host.textContent).toContain('Nothing was opened or changed.');
      await offer({ kind: 'recover', recovery });
      expect(host.querySelector('[data-testid="recovery-dialog"] [role="alert"]')).toBeNull();
    });
  }

  it('clears a thrown recovery and a failed encoding continuation as before', async () => {
    await offer({ kind: 'recover', recovery });
    vi.mocked(completeRecovery).mockRejectedValueOnce(new Error('Recovery failed'));
    await act(async () => button('Open this copy').click());
    expect(phase()).toBe('idle');
    expect(host.querySelector('[data-testid="recovery-dialog"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Recovering the project did not finish: Recovery failed');
    await offer({ kind: 'encoding', encoding: { ...encoding, cancelNote: 'The recovered manifest was written.' } });
    vi.mocked(completeEncodingReview).mockRejectedValueOnce(new Error('Conversion failed'));
    await act(async () => button('Open the project').click());
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Opening the project did not finish: Conversion failed');
    expect(host.textContent).not.toContain('The recovered manifest was written.');
  });

  for (const outcome of [{ kind: 'recover', recovery }, { kind: 'differs', differs }, { kind: 'opened', opened }] satisfies OpenOutcome[]) {
    it(`settles an encoding continuation into ${outcome.kind}`, async () => {
      await offer({ kind: 'encoding', encoding });
      vi.mocked(completeEncodingReview).mockResolvedValueOnce(outcome);
      await act(async () => button('Open the project').click());
      expect(completeEncodingReview).toHaveBeenCalledWith(store, encoding, []);
      expect(phase()).toBe(outcome.kind === 'recover' ? 'recovery' : outcome.kind === 'opened' ? 'idle' : 'differs');
      expect(onOpened).toHaveBeenCalledTimes(outcome.kind === 'opened' ? 1 : 0);
    });
  }

  for (const [label, answer] of [
    ['Use the folder’s version', 'use-folder'],
    ['Keep this browser’s version and save it to the folder', 'keep-browser'],
    ['Open as a separate copy', 'separate-copy'],
  ] as const) {
    it(`preserves the ${answer} answer and opens its exact result`, async () => {
      await offer({ kind: 'differs', differs });
      vi.mocked(answerFolderDiffers).mockResolvedValueOnce(opened);
      await act(async () => button(label).click());
      expect(answerFolderDiffers).toHaveBeenCalledWith(store, differs, answer);
      expect(phase()).toBe('idle');
      expect(onOpened).toHaveBeenCalledExactlyOnceWith(opened);
    });
  }
});
