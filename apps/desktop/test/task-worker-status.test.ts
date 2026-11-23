import { beforeEach, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { createEmptyManifest, createProjectState } from '@caotang/store';

import { announcementFor, viewOf } from '../src/app/task-model.js';
import type { TaskRecord } from '../src/app/task-store.js';
import { messages } from '../src/i18n/locales/en/messages.po';

const state = createProjectState(createEmptyManifest('A fictional task project'));
const task: TaskRecord = {
  id: 'task_FICTION001', projectId: state.manifest.project.id, intent: 'Draft the lamp scene.',
  steps: [{ tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Continue.' }, expect: 'A draft' }],
  items: [{ key: '0', step: 0, state: 'pending' }], status: 'running',
  cap: 1, used: 0, promptTokens: 0, completionTokens: 0, runs: 1, createdAt: 0, updatedAt: 0,
};

beforeEach(() => {
  i18n.load('en', messages);
  i18n.activate('en');
});

it('describes preparation before the task has recorded a model call', () => {
  expect(viewOf(task, state).statusText).toBe('Preparing the next draft.');
  expect(viewOf({ ...task, used: 1 }, state).statusText).toBe('Drafting: 0 of 1 done');
});

it('announces completed cancellation without calling it a resumable interruption', () => {
  expect(announcementFor({ ...task, status: 'cancelled' })).toContain('A background task was cancelled:');
  expect(viewOf({ ...task, status: 'cancelled' }, state)).toMatchObject({ canResume: false, canCancel: false, canDismiss: true });
});

it('counts only drafts in total/done for review and mixed tasks, never the coherence item', () => {
  const reviewItem = { key: '0', step: 0, state: 'staged' as const };
  const nativeOnly: TaskRecord = {
    ...task, id: 'task_MIXNATIVE', kind: 'mixed', status: 'running',
    steps: [{ tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' }, { tool: 'project.overview', params: {}, expect: 'An overview' }],
    items: [reviewItem],
  };
  expect(viewOf(nativeOnly, state)).toMatchObject({ total: 0, done: 0 });
  const oneDraft: TaskRecord = {
    ...nativeOnly, id: 'task_MIXDRAFT',
    steps: [...nativeOnly.steps, { tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' }],
    items: [reviewItem, { key: '2', step: 2, state: 'staged' }],
  };
  expect(viewOf(oneDraft, state)).toMatchObject({ total: 1, done: 1 });
  expect(viewOf({ ...task, kind: 'draft' }, state)).toMatchObject({ total: 1, done: 0 });
});
