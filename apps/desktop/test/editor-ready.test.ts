// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it } from 'vitest';
import { focusEditorWhenReady, publishEditorReady } from '../src/app/editor-ready.js';

let page: HTMLElement;
let sidebar: HTMLElement;
let field: HTMLElement;
let editor: HTMLElement;
let cleanup: () => void;

beforeEach(() => {
  document.body.innerHTML = '<nav><button>Scene</button></nav><main tabindex="-1"><article data-editor-state="loading"><div contenteditable="true" tabindex="0"></div></article></main><button id="elsewhere">Elsewhere</button>';
  sidebar = document.querySelector('nav')!;
  page = document.querySelector('main')!;
  editor = document.querySelector('article')!;
  field = document.querySelector('[contenteditable]')!;
  sidebar.querySelector('button')!.focus();
  cleanup = focusEditorWhenReady(page, sidebar);
});

afterEach(() => { cleanup(); document.body.replaceChildren(); });

it('waits for the published ready state rather than focusing a partially mounted surface', () => {
  publishEditorReady(editor);
  expect(document.activeElement).toBe(sidebar.querySelector('button'));
  editor.dataset.editorState = 'ready';
  publishEditorReady(editor);
  expect(document.activeElement).toBe(field);
});

it('does not take focus back after the writer moves elsewhere', () => {
  const elsewhere = document.getElementById('elsewhere')!;
  elsewhere.focus();
  page.focus();
  editor.dataset.editorState = 'ready';
  publishEditorReady(editor);
  expect(document.activeElement).toBe(page);
});

it('cancels the request on cleanup', () => {
  cleanup();
  editor.dataset.editorState = 'ready';
  publishEditorReady(editor);
  expect(document.activeElement).toBe(sidebar.querySelector('button'));
});

it('focuses an editor that was ready before the sidebar closed', () => {
  cleanup();
  editor.dataset.editorState = 'ready';
  cleanup = focusEditorWhenReady(page, sidebar);
  expect(document.activeElement).toBe(field);
});

it('finishes page focus when the requested editor fails instead of becoming ready', () => {
  editor.dataset.editorState = 'failed';
  publishEditorReady(editor);
  expect(document.activeElement).toBe(page);
  sidebar.querySelector('button')!.focus();
  editor.dataset.editorState = 'ready';
  publishEditorReady(editor);
  expect(document.activeElement).toBe(sidebar.querySelector('button'));
});

it('focuses the page when the requested editor has already failed', () => {
  cleanup();
  editor.dataset.editorState = 'failed';
  cleanup = focusEditorWhenReady(page, sidebar);
  expect(document.activeElement).toBe(page);
});

it.each(['sp-view', 'dlg-view'])('focuses the page for a ready %s without choosing its hidden source field', (view) => {
  cleanup();
  page.innerHTML = `<section class="media-view ${view}" data-editor-state="ready"><textarea hidden></textarea></section>`;
  cleanup = focusEditorWhenReady(page, sidebar);
  expect(document.activeElement).toBe(page);
});

it.each(['sp-view', 'dlg-view'])('waits for an asynchronously mounted %s to publish readiness before finishing page focus', (view) => {
  cleanup();
  page.innerHTML = `<section class="media-view ${view}" data-editor-state="loading"><textarea hidden></textarea></section>`;
  cleanup = focusEditorWhenReady(page, sidebar);
  expect(document.activeElement).toBe(sidebar.querySelector('button'));
  const media = page.querySelector<HTMLElement>('.media-view')!;
  media.dataset.editorState = 'ready';
  publishEditorReady(media);
  expect(document.activeElement).toBe(page);
  document.body.focus();
  sidebar.querySelector('button')!.focus();
  publishEditorReady(media);
  expect(document.activeElement).toBe(sidebar.querySelector('button'));
});
