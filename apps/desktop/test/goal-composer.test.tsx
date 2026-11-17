// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createAgent } from '@ui-sdk/react/agent';
import { addDocument, createEmptyManifest, createProjectState } from '@caotang/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ProjectSession } from '../src/app/session.js';
import GoalComposer, { type GoalComposerProps } from '../src/components/GoalComposer.js';
import { activateEnglish } from '../src/i18n/runtime.js';

let root: Root;
let host: HTMLDivElement;
let props: GoalComposerProps;
let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.checkVisibility = () => true;
  HTMLElement.prototype.showPopover = () => undefined;
  HTMLElement.prototype.hidePopover = () => undefined;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const state = createProjectState(createEmptyManifest('The harbour', new Date(0)));
  addDocument(state, { parentId: 'manuscript', id: 'n_HARBOUR001', title: 'The landing', body: 'The boat arrived.', now: new Date(0) });
  const session = { state, rulesNow: () => [], view: { activeDocId: 'n_HARBOUR001' }, subscribe: () => () => undefined, getVersion: () => 0 } as unknown as ProjectSession;
  props = { open: true, session, coherenceChecks: ['codex.alias-collisions'], draft: null, unavailable: null, busy: false, onStart: vi.fn(), onClose: vi.fn() };
  approve = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(change: Partial<GoalComposerProps> = {}): Promise<void> {
  props = { ...props, ...change };
  await act(async () => root.render(<I18nProvider i18n={i18n}><GoalComposer {...props} /></I18nProvider>));
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (found === undefined) throw new Error(`Missing button: ${text}`);
  return found;
}

async function change(ref: string, action: string, args: unknown[]): Promise<void> {
  await act(async () => {
    const outcome = await agent.act({ steps: [{ ref, action, args }] });
    expect(outcome.ok, outcome.error?.message).toBe(true);
  });
}

async function submit(): Promise<void> {
  await act(async () => { host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

it('names its controls for agents and requires confirmation before starting a finite goal', async () => {
  await render();
  const entries = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more');
  for (const entry of entries) expect(entry.label, `${entry.component} is unnamed`).toBeTruthy();
  for (const name of ['Goal intent', 'Every synopsis is filled', 'Model-call limit', 'Start the goal']) expect(entries.map((entry) => entry.label)).toContain(name);
  await change('Goal intent', 'setValue', ['Fill the scene synopses.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  await change('Model-call limit', 'setValue', ['3']);
  let outcome;
  await act(async () => { outcome = await agent.act({ steps: [{ ref: 'Start the goal', action: 'press', args: [] }] }); });
  expect(outcome).toMatchObject({ ok: false });
  expect(props.onStart).not.toHaveBeenCalled();
  approve = true;
  await change('Start the goal', 'press', []);
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^g_[0-9A-HJKMNP-TV-Z]{10}$/), intent: 'Fill the scene synopses.', checks: [{ kind: 'synopsis.filled', scope: { mode: 'full' } }], limits: { maxModelCalls: 3 }, writeScope: { mode: 'full' } }), false);
});

it('validates on submit and focuses the first invalid field without premature alerts', async () => {
  await render();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await submit();
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Say what you want');
  await change('Goal intent', 'setValue', ['Fill the synopses.']);
  await submit();
  expect(document.activeElement).toBe(host.querySelector('[data-goal-field="checks"] [role="checkbox"]'));
  expect(props.onStart).not.toHaveBeenCalled();
});

it('exposes optional review and its explicit gate through the SDK agent without raising shared limits', async () => {
  await render();
  const optional = [...host.querySelectorAll('label')].find(label => label.textContent === 'Add an independent review')?.querySelector('[role="checkbox"]');
  expect(optional).not.toBeNull();
  expect(optional?.getAttribute('aria-checked')).toBe('false');
  await change('Goal intent', 'setValue', ['Clarify the departure.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  await change('Add an independent review', 'setChecked', [true]);
  const entries = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more');
  for (const entry of entries) expect(entry.label, `${entry.component} is unnamed`).toBeTruthy();
  for (const name of ['Add an independent review', 'Review criterion', 'Require this review to pass']) expect(entries.map(entry => entry.label)).toContain(name);
  const rubric = host.querySelector<HTMLTextAreaElement>('[data-goal-field="rubric"] textarea');
  expect(rubric?.getAttribute('aria-invalid')).not.toBe('true');
  await change('Review criterion', 'setValue', ['The departure is clear.']);
  await submit();
  expect(props.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ limits: { maxModelCalls: 8 }, checks: [
    { kind: 'synopsis.filled', scope: { mode: 'full' } },
    { kind: 'verifier', scope: { mode: 'full' }, rubric: 'The departure is clear.', gate: false },
  ] }), false);
  await change('Require this review to pass', 'setChecked', [true]);
  await submit();
  expect(props.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ checks: expect.arrayContaining([expect.objectContaining({ kind: 'verifier', gate: true })]) }), false);
});

it('focuses a missing review criterion only after submission and clears its error on input', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Clarify the departure.']);
  await change('Add an independent review', 'setChecked', [true]);
  await change('Require this review to pass', 'setChecked', [true]);
  const rubric = host.querySelector<HTMLTextAreaElement>('[data-goal-field="rubric"] textarea');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(rubric?.getAttribute('aria-invalid')).toBe('false');
  await submit();
  expect(document.activeElement).toBe(rubric);
  expect(rubric?.getAttribute('aria-invalid')).toBe('true');
  expect(props.onStart).not.toHaveBeenCalled();
  await change('Review criterion', 'setValue', ['The departure is clear.']);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(rubric?.getAttribute('aria-invalid')).toBe('false');
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'verifier', scope: { mode: 'full' }, rubric: 'The departure is clear.', gate: true }] }), false);
});

it('matches writes to the default named document without requiring another picker change', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Fill this scene synopsis.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  await change('Check scope', 'setValue', ['doc']);
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({
    checks: [{ kind: 'synopsis.filled', scope: { mode: 'doc', docIds: ['n_HARBOUR001'] } }],
    writeScope: { mode: 'doc', docIds: ['n_HARBOUR001'] },
  }), false);
});

it('selects a named binder folder with a matching explicit write scope', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Fill synopses in this folder.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  await change('Check scope', 'setValue', ['doc']);
  await change('Binder document or folder', 'setValue', ['manuscript']);
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({
    checks: [{ kind: 'synopsis.filled', scope: { mode: 'doc', docIds: ['manuscript'] } }],
    writeScope: { mode: 'doc', docIds: ['manuscript'] },
  }), false);
});

it('does not request large-scope consent for documents withheld from the goal', async () => {
  for (let index = 0; index < 21; index += 1) addDocument(props.session.state, { parentId: 'manuscript', id: `held-${index}`, title: `Held scene ${index}`, body: 'A scene.', now: new Date(0) });
  vi.spyOn(props.session, 'rulesNow').mockReturnValue([{ tool: '*', effect: 'deny', access: 'read', scope: { subtree: 'manuscript' }, source: 'app' }]);
  await render({ draft: { id: 1, intent: 'Resolve the readable findings.', scope: { mode: 'full' }, coherenceChecks: ['codex.alias-collisions'] } });
  expect(host.textContent).not.toContain('This coherence scope reads more than 20 documents.');
});

it('defaults a named coherence scope to a live document when none is open', async () => {
  await render({ session: { ...props.session, view: { activeDocId: null } } as unknown as ProjectSession });
  await change('Goal intent', 'setValue', ['Resolve the scene findings.']);
  await change('No open coherence findings', 'setChecked', [true]);
  await change('Check scope', 'setValue', ['doc']);
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'coherence.clean', scope: { mode: 'doc', docIds: ['n_HARBOUR001'] }, checks: ['codex.alias-collisions'] }] }), false);
});

it('refuses a named coherence scope archived while the composer stays open', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Resolve the scene findings.']);
  await change('No open coherence findings', 'setChecked', [true]);
  await change('Check scope', 'setValue', ['doc']);
  expect(button('Start the goal').getAttribute('aria-disabled')).not.toBe('true');
  props.session.state.manifest.tree.find((node) => node.id === 'n_HARBOUR001')!.status = 'archived';
  await render();
  expect(button('Start the goal').getAttribute('aria-disabled')).toBe('true');
  expect(host.textContent).toContain('Coherence needs exactly one live document here.');
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
});

it('retains an unfinished draft while closed and applies only new prefill ids without execution', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Keep this unfinished intent.']);
  await act(async () => button('Back to one turn').click());
  expect(props.onClose).toHaveBeenCalledTimes(1);
  await render({ open: false });
  expect(host.textContent).toBe('');
  await render({ open: true });
  expect(host.querySelector('textarea')?.value).toBe('Keep this unfinished intent.');
  const draft = { id: 7, intent: 'Resolve these findings.', scope: { mode: 'changed' as const }, coherenceChecks: ['branch.dead-end' as const] };
  await render({ draft });
  expect(host.querySelector('textarea')?.value).toBe(draft.intent);
  await change('Goal intent', 'setValue', ['My adjusted intent.']);
  await render({ draft: { ...draft } });
  expect(host.querySelector('textarea')?.value).toBe('My adjusted intent.');
  await render({ draft: { ...draft, id: 8 } });
  expect(host.querySelector('textarea')?.value).toBe(draft.intent);
  expect(props.onStart).not.toHaveBeenCalled();
});

it('retains an ineligible requested scope and check instead of silently broadening or dropping it', async () => {
  await render({ coherenceChecks: ['codex.alias-collisions', 'branch.dead-end'], draft: { id: 1, intent: 'Resolve these findings.', scope: { mode: 'changed' }, coherenceChecks: ['codex.alias-collisions', 'branch.dead-end'] } });
  expect(host.querySelector<HTMLInputElement>('[name="goal-scope"][value="changed"]')?.checked).toBe(true);
  expect(button('Start the goal').getAttribute('aria-disabled')).toBe('true');
  expect(host.textContent).toContain('Some selected checks require the whole manuscript.');
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
  await change('A dialogue knot can never be reached — Whole manuscript only', 'setChecked', [false]);
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'coherence.clean', scope: { mode: 'changed' }, checks: ['codex.alias-collisions'] }] }), false);
});

it('refuses an off-setting prefill check until the writer explicitly deselects or enables it', async () => {
  await render({ draft: { id: 1, intent: 'Resolve findings.', scope: { mode: 'full' }, coherenceChecks: ['branch.dead-end'] } });
  expect(host.textContent).toContain('A selected check is off in Settings.');
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
  await render({ coherenceChecks: ['branch.dead-end'] });
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'coherence.clean', scope: { mode: 'full' }, checks: ['branch.dead-end'] }] }), false);
});

it('keeps unavailable Start focusable with a visible reason and never submits it', async () => {
  await render({ unavailable: 'Web Locks are unavailable.' });
  const start = button('Start the goal');
  expect(start.disabled).toBe(false);
  expect(start.getAttribute('aria-disabled')).toBe('true');
  expect(document.getElementById(start.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Web Locks are unavailable.');
  await act(async () => start.focus());
  expect(document.activeElement).toBe(start);
  await act(async () => start.click());
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
});

it('requires fresh large-scope approval after a check definition changes', async () => {
  for (let n = 0; n < 21; n++) addDocument(props.session.state, { parentId: 'manuscript', id: `n_EXTRA${String(n).padStart(5, '0')}`, title: `Extra ${n}`, body: 'The boat arrived.', now: new Date(0) });
  await render({ draft: { id: 1, intent: 'Resolve findings.', scope: { mode: 'full' }, coherenceChecks: ['codex.alias-collisions'] } });
  expect(button('Start the goal').getAttribute('aria-disabled')).toBe('true');
  await change('I approve reading this large scope for these checks', 'setChecked', [true]);
  expect(button('Start the goal').getAttribute('aria-disabled')).not.toBe('true');
  await change('Every synopsis is filled', 'setChecked', [true]);
  expect(button('Start the goal').getAttribute('aria-disabled')).toBe('true');
  await change('I approve reading this large scope for these checks', 'setChecked', [true]);
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.anything(), true);
});

it('lets an incomplete large-scope goal explain and focus its missing fields before consent', async () => {
  for (let n = 0; n < 21; n++) addDocument(props.session.state, { parentId: 'manuscript', id: `n_EXTRA${String(n).padStart(5, '0')}`, title: `Extra ${n}`, body: 'The boat arrived.', now: new Date(0) });
  await render();
  await change('No open coherence findings', 'setChecked', [true]);
  expect(button('Start the goal').getAttribute('aria-disabled')).not.toBe('true');
  await submit();
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Say what you want');
  expect(props.onStart).not.toHaveBeenCalled();
});

it('ignores an IME-confirming Enter submit', async () => {
  await render();
  await change('Goal intent', 'setValue', ['Fill the synopses.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  await act(async () => {
    host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(props.onStart).not.toHaveBeenCalled();
});

it('operates all four completion checks with Space and keeps ordinary Enter available in the intent', async () => {
  await render();
  for (const label of ['No open coherence findings', 'Every document meets a word range', 'Every document has a status', 'Every synopsis is filled']) {
    const control = [...host.querySelectorAll<HTMLButtonElement>('label > [role="checkbox"]')].find((node) => node.parentElement?.textContent === label);
    if (control === undefined) throw new Error(`Missing check: ${label}`);
    await act(async () => {
      control.focus();
      const down = control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
      const up = control.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
      if (down && up) control.click();
    });
    expect(control.getAttribute('aria-checked'), label).toBe('true');
  }
  const intent = host.querySelector('textarea');
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => { intent?.dispatchEvent(enter); });
  expect(enter.defaultPrevented).toBe(false);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more').every((entry) => entry.label)).toBe(true);
});

it('does not ask for large coherence consent for a synopsis-only goal', async () => {
  for (let n = 0; n < 21; n++) addDocument(props.session.state, { parentId: 'manuscript', id: `n_EXTRA${String(n).padStart(5, '0')}`, title: `Extra ${n}`, body: 'The boat arrived.', now: new Date(0) });
  await render();
  await change('Goal intent', 'setValue', ['Fill the synopses.']);
  await change('Every synopsis is filled', 'setChecked', [true]);
  expect(host.textContent).not.toContain('I approve reading this large scope');
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'synopsis.filled', scope: { mode: 'full' } }] }), false);
});

it('keeps a requested missing document visible and refuses coherence instead of substituting the active document', async () => {
  await render({ draft: { id: 1, intent: 'Resolve these findings.', scope: { mode: 'doc', docIds: ['n_MISSING001'] }, coherenceChecks: ['codex.alias-collisions'] } });
  expect(host.textContent).toContain('n_MISSING001');
  expect(host.textContent).toContain('Coherence needs exactly one live document here.');
  expect(button('Start the goal').getAttribute('aria-disabled')).toBe('true');
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
  await act(async () => button('Use the current document').click());
  await submit();
  expect(props.onStart).not.toHaveBeenCalled();
  expect(host.textContent).toContain('The write scope has no live binder item.');
  await act(async () => button('Write only in the current document').click());
  await submit();
  expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ kind: 'coherence.clean', scope: { mode: 'doc', docIds: ['n_HARBOUR001'] }, checks: ['codex.alias-collisions'] }], writeScope: { mode: 'doc', docIds: ['n_HARBOUR001'] } }), false);
});
