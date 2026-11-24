// @vitest-environment jsdom
/**
 * Settings › MCP & tools › This project's server (#406, desktop.md §The project's own MCP server): the configuration the page copies
 * for a host, and what the block does with the states the main process reports — start, stop, the writes switch that restarts a
 * running server, and a refusal shown as the sentence it is.
 *
 * The bridge is the only thing faked: `window.caotangDesktop.mcp` is the same shape the preload exposes, so the test proves the page's
 * side of the wiring rather than a mock of it. What the shell does with those calls is the shell suite's (`mcp-host.spec.ts`).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DesktopMcpBridge, McpHostStatus } from '../../desktop-shell/src/mcp-contract.cjs';
import type {} from '../../desktop-shell/src/folder-contract.cjs';
import { projectServerConfig, projectServerHoldsFolder, projectServerStatus } from '../src/app/native-mcp.js';
import { ProjectServerSection } from '../src/components/ProjectServer.js';
import { activateEnglish } from '../src/i18n/runtime.js';

let root: Root;
let host: HTMLDivElement;

const RUNNING: McpHostStatus = {
  state: 'running',
  url: 'http://127.0.0.1:7433/mcp',
  token: 'fixture-token-value',
  allowWrites: false,
  since: '2026-11-23T10:00:00.000Z',
  folderId: 'fld_AAAAAAAAAA',
};

/** A bridge that records what the page asked and answers with what its owner put in `answer`. */
function bridge(
  start: (folderId: string, allowWrites: boolean) => McpHostStatus = () => RUNNING,
  initial: McpHostStatus = RUNNING,
) {
  const calls: string[] = [];
  const status = { current: initial };
  const listeners = new Set<(next: McpHostStatus) => void>();
  const api: DesktopMcpBridge = {
    start: async (folderId, allowWrites) => {
      calls.push(`start ${folderId} ${String(allowWrites)}`);
      status.current = start(folderId, allowWrites);
      for (const listener of listeners) listener(status.current);
      return { ok: true, value: status.current };
    },
    stop: async () => {
      calls.push('stop');
      status.current = { state: 'stopped' };
      for (const listener of listeners) listener(status.current);
      return { ok: true, value: status.current };
    },
    status: async () => ({ ok: true, value: status.current }),
    pause: async () => ({ ok: true, value: status.current }),
    resume: async () => ({ ok: true, value: status.current }),
    onStatus: (listener) => {
      calls.push('onStatus');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { api, calls, status };
}

function install(mcp: DesktopMcpBridge): void {
  Object.defineProperty(window, 'caotangDesktop', {
    configurable: true,
    value: { version: 5, mcp },
  });
}

/** `null` is a project that is not in a folder; the component's own prop is `undefined` for that. */
async function render(folderId: string | null = 'fld_AAAAAAAAAA'): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider i18n={i18n}><ProjectServerSection folderId={folderId ?? undefined} /></I18nProvider>);
  });
  // The status is a promise made in an effect: let it land before anything is judged.
  await act(async () => {
    await Promise.resolve();
  });
}

function testId(id: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`Missing test id: ${id}`);
  return found;
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (found === undefined) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'caotangDesktop');
});

it('copies the JSON block an MCP host reads, with the token as a header', () => {
  const config = JSON.parse(projectServerConfig(RUNNING)) as {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
  };
  expect(config.mcpServers['caotang']).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:7433/mcp',
    headers: { Authorization: 'Bearer fixture-token-value' },
  });
});

it('follows the server the main process reports, and starts over the folder it was given', async () => {
  const { api, calls } = bridge();
  install(api);
  await render();

  expect(testId('mcp-project-state').textContent).toContain('Running');
  expect((testId('mcp-project-url') as HTMLInputElement).value).toBe(RUNNING.url);
  expect((testId('mcp-project-token') as HTMLInputElement).value).toBe(RUNNING.token);

  await act(async () => button('Stop').click());
  expect(calls).toContain('stop');
  expect(testId('mcp-project-state').textContent).toContain('Stopped');

  await act(async () => button('Start').click());
  // The folder id, never a path, and writes off unless the switch says otherwise.
  expect(calls).toContain('start fld_AAAAAAAAAA false');
  expect(testId('mcp-project-state').textContent).toContain('Running');
});

it('restarts a running server when Allow changes is turned on, and says what that means', async () => {
  const { api, calls } = bridge((_folderId, allowWrites) => ({ ...RUNNING, allowWrites }));
  install(api);
  await render();

  const writes = testId('mcp-project-writes') as HTMLInputElement;
  expect(writes.checked).toBe(false);
  expect(host.textContent).toContain('Off. A host can read this project and change nothing.');

  await act(async () => writes.click());
  expect(calls).toContain('start fld_AAAAAAAAAA true');
  expect((testId('mcp-project-writes') as HTMLInputElement).checked).toBe(true);
  expect(host.textContent).toContain('On. A host may change this project');
});

it('shows the server\'s own sentence when a start fails, and offers the start again', async () => {
  const { api } = bridge(
    () => ({ state: 'failed', refusal: 'busy', detail: 'the project folder is in use by another writer' }),
    { state: 'stopped' },
  );
  install(api);
  await render();

  await act(async () => button('Start').click());
  expect(testId('mcp-project-state').textContent).toContain('Not running');
  // A busy folder is the one refusal the page can word itself: it names the other program, not a path or a pid.
  expect(testId('mcp-project-refusal').textContent).toContain('Another program is already using this folder');
  expect(button('Start')).toBeDefined();
});

it('says there is nothing to serve until the project is in a folder, and asks the bridge nothing else', async () => {
  const { api, calls } = bridge(undefined, { state: 'stopped' });
  install(api);
  await render(null);

  expect((button('Start') as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain('This project is not in a folder yet. Save it to a folder to serve it.');
  expect(calls).not.toContain('start');
});

it('recognises its own server\'s lock only while that server serves this folder', async () => {
  const { api, status } = bridge();
  install(api);
  expect(await projectServerHoldsFolder('fld_AAAAAAAAAA')).toBe(true);

  status.current = { ...RUNNING, folderId: 'fld_BBBBBBBBBB' };
  expect(await projectServerHoldsFolder('fld_AAAAAAAAAA')).toBe(false);

  status.current = { state: 'stopped' };
  expect(await projectServerHoldsFolder('fld_AAAAAAAAAA')).toBe(false);
  // With no bridge at all — the browser build — no lock is ever called the app's own.
  Reflect.deleteProperty(window, 'caotangDesktop');
  expect(await projectServerHoldsFolder('fld_AAAAAAAAAA')).toBe(false);
  expect(await projectServerStatus()).toBeUndefined();
});
