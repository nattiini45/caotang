/**
 * The host-model pairs at the server (agent-harness §3, "External-only rows"; extensibility §9): `scene.brief` and `dialogue.brief`
 * hand the host what Caotang's own tool would send its model, the host's model writes, and `scene.apply` and `dialogue.apply` run its
 * reply through the in-app port behind the host's confirmation. The server holds no key and makes no model call. Nothing is mocked: the
 * folder is written by the store and the client is the SDK's own, on both the 2026-07-28 round trip and the 2025 elicitation request.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client as LegacyClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Client } from '@modelcontextprotocol/client';
import { addDocument, addFolder, createEmptyManifest, createProjectState, getBody, readProject, writeProject, type PermissionRule } from '@caotang/store';

import { NodeArtifactFs } from '../src/index.js';
import {
  FERRYMAN,
  FERRYMAN_BODY,
  LANDING,
  LANDING_BODY,
  OPENED,
  STORM,
  acceptConfirm,
  cancelConfirm,
  connectClient,
  declineConfirm,
  folderBytes,
  removeDir,
  resultJson,
  seedWriting,
  startFixture,
  startOver,
  tempDir,
  type Answer,
  type Fixture,
} from './support.js';

const BLANK = 'n_B1ANK00001';
const BLANK_TWO = 'n_B1ANK00002';
const INK = ['=== reply ===', 'Thanks for the drink.', '-> END'].join('\n');
const RULE = 'No semicolons in dialogue.';
const SECRET = 'n_SECRET0001';
const SECRET_BODY = 'The keeper buried the ledger under the third stone.';

/** The data of a successful result. */
function dataOf(result: { content: readonly unknown[]; isError?: boolean | undefined }): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return resultJson(result)['data'] as Record<string, unknown>;
}

/** The refusal's text, for a result with `isError` set. */
function refusalText(result: { content: readonly unknown[]; isError?: boolean | undefined }): string {
  expect(result.isError).toBe(true);
  return JSON.stringify(resultJson(result));
}

interface Brief {
  readonly briefId: string;
  readonly messages: { role: string; content: string }[];
  readonly applyWith: Record<string, unknown>;
  readonly applyTool: string;
  readonly framing: string;
}

/** A writer's project with an empty page added, so every mode of a draft has a document to run on. */
async function writerRoot(label: string): Promise<string> {
  const root = tempDir(label);
  await seedWriting(root);
  const fs = new NodeArtifactFs(root);
  const { state } = await readProject(fs, { now: OPENED });
  addDocument(state, { parentId: 'manuscript', title: 'Blank Page', body: '', now: OPENED, id: BLANK });
  addDocument(state, { parentId: 'manuscript', title: 'Second Page', body: '', now: OPENED, id: BLANK_TWO });
  await writeProject(fs, state, { now: OPENED });
  writeFileSync(join(root, 'CAOTANG.md'), `British spelling.\n${RULE}\n`);
  return root;
}

describe('the host-model pairs over the 2026-07-28 revision', () => {
  let readOnly: Fixture;
  let writable: Fixture;
  let roClient: Client;
  let asked: string[];
  let answer: Answer;
  let rwClient: Client;

  beforeAll(async () => {
    readOnly = await startOver(await writerRoot('briefs-ro'), false);
    writable = await startOver(await writerRoot('briefs-rw'), true);
    roClient = await connectClient(readOnly.url, readOnly.token);
    asked = [];
    answer = (params) => {
      asked.push('message' in params ? params.message : '');
      return { action: 'accept', content: { confirmed: true } };
    };
    rwClient = await connectClient(writable.url, writable.token, (params) => answer(params));
  });

  afterAll(async () => {
    await roClient?.close();
    await rwClient?.close();
    for (const fixture of [readOnly, writable]) {
      await fixture?.stop();
      if (fixture !== undefined) removeDir(fixture.root);
    }
  });

  afterEach(() => {
    asked.length = 0;
    answer = (params) => {
      asked.push('message' in params ? params.message : '');
      return { action: 'accept', content: { confirmed: true } };
    };
  });

  it('lists the two briefs in every mode, and the two applies only with --allow-writes, behind a confirmation', async () => {
    const ro = (await roClient.listTools()).tools;
    expect(ro.map((tool) => tool.name)).toEqual(expect.arrayContaining(['scene.brief', 'dialogue.brief']));
    expect(ro.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['scene.apply']));
    for (const name of ['scene.apply', 'dialogue.apply', 'scene.draft', 'dialogue.draft', 'tool.search']) expect(ro.map((tool) => tool.name), name).not.toContain(name);

    const rw = (await rwClient.listTools()).tools;
    const byName = new Map(rw.map((tool) => [tool.name, tool]));
    for (const name of ['scene.brief', 'dialogue.brief']) expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    for (const name of ['scene.apply', 'dialogue.apply']) {
      expect(byName.get(name)?.description?.startsWith('Requires user confirmation.'), name).toBe(true);
      expect(byName.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    }
    for (const name of ['scene.draft', 'dialogue.draft', 'synopsis.fill', 'tool.search', 'agent.plan']) expect(byName.has(name), name).toBe(false);
    // The server advertises no model: the tools are plain reads and writes, and tools/list does not change while it runs.
    expect(rwClient.getServerCapabilities()?.tools?.listChanged).toBe(false);
  });

  it('hands a read-only server’s host the brief, mints a handle, and leaves the folder as it was', async () => {
    const before = folderBytes(readOnly.root);
    const brief = dataOf(await roClient.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'Elena steps ashore.', mode: 'continue' } })) as unknown as Brief;
    expect(brief.briefId).toMatch(/^b_/);
    expect(brief.applyTool).toBe('scene.apply');
    expect(brief.applyWith).toEqual({ doc: LANDING, mode: 'continue', briefId: brief.briefId });
    expect(brief.framing).toContain('project data');
    const text = brief.messages.map((message) => message.content).join('\n');
    expect(text).toContain(LANDING_BODY);
    expect(text).toContain('Elena steps ashore.');
    // CAOTANG.md rides in the brief as it does in every request of the in-app agent (layer LI).
    expect(text).toContain('# Instructions');
    expect(text).toContain(RULE);
    expect(folderBytes(readOnly.root)).toEqual(before);
    // Apply is not listed here, so a call to it is not found.
    // A read-only server holds the guard in front of the tool: the write is refused as a write, and nothing is written.
    const stray = await roClient.callTool({ name: 'scene.apply', arguments: { doc: LANDING, text: 'x', mode: 'continue', briefId: brief.briefId } });
    expect(refusalText(stray)).toContain('this server is read-only');
    expect(getBody(readOnly.session.state, LANDING)).toBe(LANDING_BODY);
  });

  it('writes a continuation once the host confirms it: the question names the title and the word change and carries no prose', async () => {
    const brief = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'Elena steps ashore.', mode: 'continue' } })) as unknown as Brief;
    const prose = 'Elena stepped onto the wet stones, and the island looked back.';
    const done = await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: prose } });
    const data = dataOf(done);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('continue "The Landing" (+11 words)');
    expect(asked[0]).not.toContain('wet stones');
    const body = getBody(writable.session.state, LANDING);
    expect(body).toBe(`${LANDING_BODY}\n\n${prose}`);
    expect(parseOnDisk(writable.root, LANDING)).toBe(body);

    // Every row the call logged names the host's call as the caller, and the call is one undo group the app's model can undo.
    const rows = writable.session.harness.log.entries();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.source, row.command).toBe('mcp');
    const group = (resultJson(done) as { undoGroupId?: string }).undoGroupId;
    expect(group).toBeDefined();
    expect(data['mode']).toBe('continue');
    expect(writable.session.harness.undo.undo(group ?? '').ok).toBe(true);
    expect(getBody(writable.session.state, LANDING)).toBe(LANDING_BODY);
  });

  it('drafts into an empty page and rewrites a selected passage', async () => {
    const draft = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: BLANK, instruction: 'Open at dawn.' } })) as unknown as Brief;
    expect(draft.applyWith).toEqual({ doc: BLANK, mode: 'draft', briefId: draft.briefId });
    dataOf(await rwClient.callTool({ name: 'scene.apply', arguments: { ...draft.applyWith, text: 'Dawn came grey.' } }));
    expect(getBody(writable.session.state, BLANK)).toBe('Dawn came grey.');
    expect(asked[0]).toContain('write a draft into "Blank Page" (+3 words)');

    asked.length = 0;
    const rewrite = dataOf(
      await rwClient.callTool({ name: 'scene.brief', arguments: { doc: STORM, instruction: 'Make it a boat.', mode: 'rewrite_selection', selection: { from: 0, to: 4, exact: 'Rain', prefix: '', suffix: ' on ', capturedRevision: 0 } } }),
    ) as unknown as Brief;
    dataOf(await rwClient.callTool({ name: 'scene.apply', arguments: { ...rewrite.applyWith, text: 'Sleet' } }));
    expect(getBody(writable.session.state, STORM).startsWith('Sleet on the glass.')).toBe(true);
    expect(asked[0]).toContain('rewrite a passage of "The Storm" (0 words)');
  });

  it('leaves the folder byte-identical when the host declines or cancels, and the brief still stands for a second try', async () => {
    const brief = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'More.', mode: 'continue' } })) as unknown as Brief;
    const before = folderBytes(writable.root);
    for (const refuse of [declineConfirm, cancelConfirm]) {
      answer = refuse;
      const result = await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Never written.' } });
      expect(JSON.stringify(result.content)).toMatch(/declined|cancelled/);
      expect(folderBytes(writable.root)).toEqual(before);
    }
    expect(getBody(writable.session.state, LANDING)).not.toContain('Never written.');
    answer = acceptConfirm;
    dataOf(await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Written at last.' } }));
    expect(getBody(writable.session.state, LANDING)).toContain('Written at last.');
  });

  it('refuses a handle it does not hold, or whose document changed, before the host is asked, and writes nothing', async () => {
    const before = folderBytes(writable.root);
    const unknown = await rwClient.callTool({ name: 'scene.apply', arguments: { doc: STORM, text: 'x', mode: 'continue', briefId: 'b_0000000000' } });
    expect(refusalText(unknown)).toContain('is not one this server holds');
    expect(refusalText(unknown)).toContain('scene.brief');

    const brief = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: STORM, instruction: 'More rain.', mode: 'continue' } })) as unknown as Brief;
    dataOf(await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'First.' } }));
    asked.length = 0;
    const stale = await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Second.' } });
    const text = refusalText(stale);
    expect(text).toContain('\\"The Storm\\" has changed since the brief');
    expect(text).not.toContain(STORM);
    expect(asked).toEqual([]);
    expect(getBody(writable.session.state, STORM)).not.toContain('Second.');
    expect(folderBytes(writable.root)).not.toEqual(before);
  });

  it('refuses what scene.draft would refuse, with the in-app words, in a brief and in an apply', async () => {
    const refused = await rwClient.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'Again.' } });
    expect(refusalText(refused)).toContain('mode draft needs an empty document');
    const brief = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: BLANK_TWO, instruction: 'Again.' } })) as unknown as Brief;
    const filled = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: BLANK_TWO, instruction: 'x', mode: 'continue' } })) as unknown as Brief;
    dataOf(await rwClient.callTool({ name: 'scene.apply', arguments: { ...filled.applyWith, text: 'Now it has text.' } }));
    asked.length = 0;
    const late = await rwClient.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Draft over text.' } });
    expect(refusalText(late)).toContain('has changed since the brief');
    expect(asked).toEqual([]);
    // The reply is held to the in-app output limit, and the limit is in the schema the host reads.
    const schema = (await rwClient.listTools()).tools.find((tool) => tool.name === 'scene.apply')?.inputSchema as unknown as { properties: { text: { maxLength: number } } };
    expect(schema.properties.text.maxLength).toBe(16384);
    const fresh = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: BLANK_TWO, instruction: 'x', mode: 'continue' } })) as unknown as Brief;
    const long = await rwClient.callTool({ name: 'scene.apply', arguments: { ...fresh.applyWith, text: 'a'.repeat(16385) } });
    expect(refusalText(long)).toContain('limit 16384');
  });

  it('writes the host’s Ink into a dialogue container behind the same confirmation, and refuses Ink that does not compile', async () => {
    const brief = dataOf(await rwClient.callTool({ name: 'dialogue.brief', arguments: { doc: 'Ferryman', instruction: 'A thank-you.', target_lines: 3 } })) as unknown as Brief;
    expect(brief.applyTool).toBe('dialogue.apply');
    expect(brief.messages[0]?.content).toContain('Ink');
    expect(brief.messages.map((message) => message.content).join('\n')).toContain('The ferryman nods.');

    const broken = await rwClient.callTool({ name: 'dialogue.apply', arguments: { ...brief.applyWith, ink: ['=== reply ===', '* [Unclosed choice', '-> END'].join('\n') } });
    expect(refusalText(broken)).toMatch(/compile/i);
    expect(asked).toEqual([]);
    expect(getBody(writable.session.state, FERRYMAN)).toBe(FERRYMAN_BODY);

    dataOf(await rwClient.callTool({ name: 'dialogue.apply', arguments: { ...brief.applyWith, ink: INK } }));
    expect(asked[0]).toContain('add dialogue to "Ferryman" (+');
    expect(asked[0]).not.toContain('Thanks for the drink.');
    expect(getBody(writable.session.state, FERRYMAN)).toContain('Thanks for the drink.');
  });

  it('refuses an apply from a host that did not declare elicitation, and writes nothing', async () => {
    const brief = dataOf(await rwClient.callTool({ name: 'scene.brief', arguments: { doc: BLANK, instruction: 'x', mode: 'continue' } })) as unknown as Brief;
    const silent = await connectClient(writable.url, writable.token);
    try {
      const before = folderBytes(writable.root);
      const refused = await silent.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Unconfirmed.' } });
      expect(refusalText(refused)).toContain('needs your confirmation');
      expect(folderBytes(writable.root)).toEqual(before);
    } finally {
      await silent.close();
    }
  });
});

/** The body of a document as the folder holds it. */
function parseOnDisk(root: string, id: string): string {
  const text = readFileSync(join(root, 'docs', `${id}.md`), 'utf8');
  return text.slice(text.indexOf('\n---\n', 4) + 5).replace(/^\n/, '').replace(/\n$/, '');
}

describe('the host-model pairs over a 2025-era connection', () => {
  const open: Fixture[] = [];
  afterEach(async () => {
    for (const fixture of open.splice(0)) {
      await fixture.stop();
      removeDir(fixture.root);
    }
  });

  it('asks the host over elicitation/create, names the title and the word change only, and writes on accept', async () => {
    const fixture = await startOver(await writerRoot('briefs-legacy'), true);
    open.push(fixture);
    const asked: string[] = [];
    const client = new LegacyClient({ name: 'legacy-host-test', version: '0.0.0' }, { capabilities: { elicitation: {} }, versionNegotiation: { mode: 'legacy' } });
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push(request.params.message);
      return { action: 'accept', content: { confirmed: true } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url), { requestInit: { headers: { authorization: `Bearer ${fixture.token}` } } }));
    try {
      const brief = dataOf(await client.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'Elena steps ashore.', mode: 'continue' } })) as unknown as Brief;
      dataOf(await client.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'She stepped ashore.' } }));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('continue "The Landing" (+3 words)');
      expect(asked[0]).not.toContain('stepped ashore');
      expect(getBody(fixture.session.state, LANDING)).toBe(`${LANDING_BODY}\n\nShe stepped ashore.`);
      // The same handle is stale once the text moved.
      const stale = await client.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Again.' } });
      expect(refusalText(stale)).toContain('has changed since the brief');
      expect(asked).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('leaves the folder byte-identical when the 2025-era host declines', async () => {
    const fixture = await startOver(await writerRoot('briefs-legacy-no'), true);
    open.push(fixture);
    const client = new LegacyClient({ name: 'legacy-host-test', version: '0.0.0' }, { capabilities: { elicitation: {} }, versionNegotiation: { mode: 'legacy' } });
    client.setRequestHandler('elicitation/create', () => ({ action: 'decline' }));
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url), { requestInit: { headers: { authorization: `Bearer ${fixture.token}` } } }));
    try {
      const brief = dataOf(await client.callTool({ name: 'scene.brief', arguments: { doc: LANDING, instruction: 'x', mode: 'continue' } })) as unknown as Brief;
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'Declined.' } });
      expect(JSON.stringify(result.content)).toContain('declined');
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('the project’s rules hold for the host-model pairs', () => {
  const ACT_ONE = 'n_ACT1ANE001';
  const ACT_TWO = 'n_ACT2TW0001';
  const OPEN = 'n_0PEN000001';
  const LOCK: PermissionRule = { effect: 'deny', tool: 'scene.draft', scope: { subtree: ACT_ONE }, access: 'write', note: 'Locked for my editor' };
  const HIDE: PermissionRule = { effect: 'deny', tool: 'scene.draft', scope: { subtree: ACT_TWO }, access: 'read', note: 'Private' };

  async function ruled(rules: unknown): Promise<string> {
    const root = tempDir('briefs-rules');
    mkdirSync(root, { recursive: true });
    const fs = new NodeArtifactFs(root);
    const state = createProjectState(createEmptyManifest('Rules', OPENED));
    addFolder(state, { parentId: 'manuscript', title: 'Act 1', now: OPENED, id: ACT_ONE });
    addFolder(state, { parentId: 'manuscript', title: 'Act 2', now: OPENED, id: ACT_TWO });
    addDocument(state, { parentId: ACT_ONE, title: 'The Open Scene', body: 'Fog.', now: OPENED, id: OPEN });
    addDocument(state, { parentId: ACT_TWO, title: 'The Secret Scene', body: SECRET_BODY, now: OPENED, id: SECRET, synopsis: 'A ledger.' });
    await writeProject(fs, state, { now: OPENED });
    const path = join(root, 'caotang.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    manifest['agent'] = { rules };
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return root;
  }

  it('keeps a read-denied chapter out of every message of a brief, and refuses a brief of it', async () => {
    const root = await ruled([HIDE]);
    const server = await startOver(root, false);
    const client = await connectClient(server.url, server.token);
    try {
      const brief = await client.callTool({ name: 'scene.brief', arguments: { doc: OPEN, instruction: 'Carry on.', mode: 'continue', include_forward_outline: true } });
      const text = JSON.stringify(brief);
      expect(text).toContain('Fog.');
      expect(text).not.toContain(SECRET_BODY);
      expect(text).not.toContain('Secret');
      const refused = await client.callTool({ name: 'scene.brief', arguments: { doc: SECRET, instruction: 'Carry on.', mode: 'continue' } });
      expect(refusalText(refused)).toContain('Private');
      expect(JSON.stringify(refused)).not.toContain(SECRET_BODY);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('does not name a read-denied document an apply reaches by a title prefix, and writes nothing', async () => {
    const root = await ruled([HIDE]);
    const server = await startOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(server.url, server.token, (params) => {
      asked.push(JSON.stringify(params));
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      const brief = dataOf(await client.callTool({ name: 'scene.brief', arguments: { doc: OPEN, instruction: 'More.', mode: 'continue' } })) as unknown as Brief;
      const before = folderBytes(root);
      const refused = await client.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, doc: 'The Secret S', text: 'More fog.' } });
      expect(refusalText(refused)).toContain('off limits');
      expect(JSON.stringify(refused)).not.toContain('Secret');
      expect(asked).toEqual([]);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('refuses an apply into a locked chapter that the rule names for scene.draft, and writes nothing', async () => {
    const root = await ruled([LOCK]);
    const server = await startOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(server.url, server.token, (params) => {
      asked.push(JSON.stringify(params));
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      const brief = dataOf(await client.callTool({ name: 'scene.brief', arguments: { doc: OPEN, instruction: 'More.', mode: 'continue' } })) as unknown as Brief;
      const before = folderBytes(root);
      const refused = await client.callTool({ name: 'scene.apply', arguments: { ...brief.applyWith, text: 'More fog.' } });
      expect(refusalText(refused)).toContain('Locked for my editor');
      expect(asked).toEqual([]);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });
});

describe('a server that starts with writes off, and a project with nothing to brief', () => {
  it('serves briefs from an empty project and says so when the document is missing', async () => {
    const fixture = await startFixture({ label: 'briefs-empty', allowWrites: false, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const missing = await client.callTool({ name: 'scene.brief', arguments: { doc: 'Nowhere', instruction: 'x' } });
      expect(refusalText(missing)).toContain('not-found');
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});
