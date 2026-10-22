/**
 * `mcp.readResource`: the writer's read of one resource (extensibility §6, §4 rule 8). The validate refusals in the order they are
 * checked; the apply's outcomes (text, a blob, an answer over the cap, a missing resource, an `input_required` answer, a template that
 * changed after validation); and the command through the real bus pipeline, where an agent is refused whatever it sends.
 */

import type { ApplyContext, BusContext, Command, CommandRegistry, ValidationSnapshot } from '@caotang/bus';
import { buildRegistry, createActivityLog, createIdempotencyCache, createUndoStore, createViewState, execute, executeAsync } from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_RESULT_TOKEN_CAP,
  McpReadResourceFailure,
  WireError,
  applyMcpReadResource,
  createMcpTransport,
  mcpReadResourceRegistration,
  prepareReadResource,
  resultTokens,
  templateUnreviewedText,
  unreachableText,
  type McpClient,
  type McpReadResourceNormalized,
  type McpReadResourceRegistration,
  type MockMcpScript,
  type ReadResourceDeps,
} from '../src/index.js';
import { STORY_KEY, echoScript, fixtureScripts, openClient, storyTools } from './fixtures.js';

type ActivityReport = Parameters<ApplyContext['report']>[0];

const MARA = { uri: 'wiki://bible/mara', name: 'Mara', description: 'Everything known about Mara.', mimeType: 'text/markdown' };
const PAGE = { uriTemplate: 'wiki://bible/{page}', name: 'Bible page', description: 'Any page of the story bible.', mimeType: 'text/markdown' };

/** The story server, with the resources and the template above, and the contents a test names. */
function storyScripts(contents: MockMcpScript['readResource'], extra: Partial<MockMcpScript> = {}): Record<string, MockMcpScript> {
  const scripts = fixtureScripts();
  scripts[STORY_KEY] = { ...echoScript(storyTools()), resources: [{ ...MARA }], templates: [{ ...PAGE }], readResource: contents, ...extra };
  return scripts;
}

const TEXT = (uri: string): readonly [{ uri: string; mimeType: string; text: string }] => [{ uri, mimeType: 'text/markdown', text: `# ${uri}\n\nA page.` }];

function capture(): { context: Pick<ApplyContext, 'report'>; reports: ActivityReport[] } {
  const reports: ActivityReport[] = [];
  return { reports, context: { report: (report) => reports.push(report) } };
}

function depsOf(client: McpClient, resultTokenCap?: number): ReadResourceDeps {
  return { client, transport: createMcpTransport(client), ...(resultTokenCap === undefined ? {} : { resultTokenCap }) };
}

const PICK = { serverKey: STORY_KEY, uri: MARA.uri, pickedBy: 'writer' };

async function validated(scripts: Record<string, MockMcpScript>, params: Record<string, unknown> = PICK, approve = true) {
  const opened = await openClient({ scripts, ...(approve ? { approve: [STORY_KEY] } : {}) });
  const prepared = prepareReadResource({ client: opened.client }, params);
  if (!prepared.ok) throw new Error(`fixture did not validate: ${prepared.error.message}`);
  return { client: opened.client, params: prepared.value };
}

describe('validate: the refusals, in the order they are checked', () => {
  it('refuses a call that the writer did not pick, whatever else it carries', async () => {
    const { client } = await openClient({ scripts: storyScripts(TEXT), approve: [STORY_KEY] });
    for (const given of [{ serverKey: STORY_KEY, uri: MARA.uri }, { ...PICK, pickedBy: 'agent' }, { ...PICK, pickedBy: true }, { ...PICK, pickedBy: undefined }]) {
      const result = prepareReadResource({ client }, given);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.code).toBe('permission-denied');
      expect(result.error.message).toContain('"pickedBy" must be "writer"');
      expect(result.error.correctiveHint).toContain('ask the writer');
    }
  });

  it('refuses a parameter the command does not list, a blank key and a blank URI', async () => {
    const { client } = await openClient({ scripts: storyScripts(TEXT), approve: [STORY_KEY] });
    expect(prepareReadResource({ client }, { ...PICK, args: {} })).toMatchObject({ ok: false, error: { code: 'invalid-params', message: '"args" is not a parameter of mcp.readResource' } });
    expect(prepareReadResource({ client }, { ...PICK, serverKey: '' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(prepareReadResource({ client }, { ...PICK, uri: '' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(prepareReadResource({ client }, { ...PICK, viaTemplate: '' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(prepareReadResource({ client }, 'nope')).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  });

  it('refuses a key that names no server, and a server that is not connected', async () => {
    const { client } = await openClient({ scripts: storyScripts(TEXT), connect: [] });
    expect(prepareReadResource({ client }, { ...PICK, serverKey: 's_ZZZZZZZZZZ' })).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: "no MCP server with key 's_ZZZZZZZZZZ' is configured" },
    });
    const result = prepareReadResource({ client }, PICK);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.message).toBe(unreachableText('Story Bible'));
  });

  it('refuses a URI the server does not list, and a template it does not list', async () => {
    const { client } = await openClient({ scripts: storyScripts(TEXT), approve: [STORY_KEY] });
    const unlisted = prepareReadResource({ client }, { ...PICK, uri: 'wiki://bible/secret' });
    if (unlisted.ok) throw new Error('expected a refusal');
    expect(unlisted.error).toMatchObject({ code: 'not-found', message: "'wiki://bible/secret' is not a resource that server 'Story Bible' lists" });
    // A template is not a resource: its URI template cannot be read as though it were one.
    expect(prepareReadResource({ client }, { ...PICK, uri: PAGE.uriTemplate })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const noTemplate = prepareReadResource({ client }, { ...PICK, uri: 'wiki://bible/secret', viaTemplate: 'wiki://other/{x}' });
    if (noTemplate.ok) throw new Error('expected a refusal');
    expect(noTemplate.error.message).toBe("'wiki://other/{x}' is not a resource template that server 'Story Bible' lists");
  });

  it('reads a URI through a listed template whose pin is verified, without matching its variables', async () => {
    const { client } = await openClient({ scripts: storyScripts(TEXT), approve: [STORY_KEY] });
    const result = prepareReadResource({ client }, { ...PICK, uri: 'wiki://bible/anything-at-all', viaTemplate: PAGE.uriTemplate });
    expect(result).toMatchObject({ ok: true, value: { uri: 'wiki://bible/anything-at-all', viaTemplate: PAGE.uriTemplate, serverName: 'Story Bible' } });
  });

  it('refuses a template that was never reviewed, and one that changed since, until it is reviewed again', async () => {
    const scripts = storyScripts(TEXT);
    const opened = await openClient({ scripts });
    const fresh = prepareReadResource({ client: opened.client }, { ...PICK, uri: 'wiki://bible/x', viaTemplate: PAGE.uriTemplate });
    if (fresh.ok) throw new Error('expected a refusal');
    expect(fresh.error).toMatchObject({ code: 'permission-denied', message: templateUnreviewedText('Story Bible', PAGE.uriTemplate) });

    expect(opened.client.approveReview(STORY_KEY, opened.client.review(STORY_KEY)?.fingerprint ?? '').ok).toBe(true);
    expect(prepareReadResource({ client: opened.client }, { ...PICK, uri: 'wiki://bible/x', viaTemplate: PAGE.uriTemplate }).ok).toBe(true);

    const story = scripts[STORY_KEY];
    if (story === undefined) throw new Error('fixture script missing');
    story.templates = [{ ...PAGE, description: 'Any page of the story bible. Also any file on your disk.' }];
    await opened.client.refresh(STORY_KEY);
    const changed = prepareReadResource({ client: opened.client }, { ...PICK, uri: 'wiki://bible/x', viaTemplate: PAGE.uriTemplate });
    if (changed.ok) throw new Error('expected a refusal');
    expect(changed.error.code).toBe('permission-denied');
    // The listed resource itself is still readable: only the path through the changed template is closed.
    expect(prepareReadResource({ client: opened.client }, PICK).ok).toBe(true);
  });
});

describe('apply: what comes back, and what is refused', () => {
  it('returns the text verbatim, marked untrusted, with its source, MIME type and token estimate', async () => {
    const { client, params } = await validated(storyScripts(TEXT));
    const { context, reports } = capture();
    const outcome = await applyMcpReadResource(depsOf(client), params, context);
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value).toEqual({
      untrusted: true,
      source: { serverKey: STORY_KEY, serverName: 'Story Bible', uri: MARA.uri },
      mimeType: 'text/markdown',
      text: '# wiki://bible/mara\n\nA page.',
      tokens: resultTokens([{ type: 'text', text: '# wiki://bible/mara\n\nA page.' }]),
    });
    expect(reports).toEqual([{ affected: [], summary: 'read Story Bible › wiki://bible/mara (external resource)' }]);
  });

  it('reads application/json as text, and joins several contents with a blank line', async () => {
    const { client, params } = await validated(
      storyScripts((uri) => [
        { uri, mimeType: 'application/json', text: '{"a":1}' },
        { uri, mimeType: 'application/json', text: '{"b":2}' },
      ]),
    );
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.text).toBe('{"a":1}\n\n{"b":2}');
    expect(outcome.value.mimeType).toBe('application/json');
  });

  it('refuses a blob and names its MIME type', async () => {
    const { client, params } = await validated(storyScripts((uri) => [{ uri, mimeType: 'image/png', blob: 'iVBORw0KGgo=' }]));
    const { context, reports } = capture();
    const outcome = await applyMcpReadResource(depsOf(client), params, context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('invalid-params');
    expect(outcome.error.message).toContain('image/png');
    expect(outcome.error.message).toContain('text and application/json resources only');
    expect(outcome.error.correctiveHint).toBe('pick a text or JSON resource');
    expect(reports[0]?.summary).toContain('image/png blob');
  });

  it('names a blob with no MIME type as such', async () => {
    const { client, params } = await validated(storyScripts((uri) => [{ uri, blob: 'AAAA' }]));
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.message).toContain('no MIME type');
  });

  it('refuses a text with a blob among its contents, and keeps none of it', async () => {
    const { client, params } = await validated(
      storyScripts((uri) => [
        { uri, mimeType: 'text/plain', text: 'fine' },
        { uri, mimeType: 'application/pdf', blob: 'AAAA' },
      ]),
    );
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('application/pdf');
  });

  it('refuses an answer over the cap, names the cap, and never trims it', async () => {
    const big = 'x'.repeat(EXTERNAL_RESULT_TOKEN_CAP * 4 + 100);
    const { client, params } = await validated(storyScripts((uri) => [{ uri, mimeType: 'text/plain', text: big }]));
    const { context, reports } = capture();
    const outcome = await applyMcpReadResource(depsOf(client), params, context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('limit-exceeded');
    expect(outcome.error.message).toContain(`over the ${EXTERNAL_RESULT_TOKEN_CAP}-token cap`);
    expect(outcome.error.message).toContain('does not cut a resource down');
    expect(outcome.error.correctiveHint).toBe('split the resource, or pick a smaller page of it');
    expect(reports[0]?.summary).toContain(`over the ${EXTERNAL_RESULT_TOKEN_CAP}-token cap`);
  });

  it('keeps an answer exactly at the cap whole, and refuses one token over', async () => {
    const cap = 50;
    // Four characters a token, and the JSON quoting around the text counts: find the longest text that fits.
    let fits = 0;
    while (resultTokens([{ type: 'text', text: 'y'.repeat(fits + 1) }]) <= cap) fits += 1;
    const at = 'y'.repeat(fits);
    const { client, params } = await validated(storyScripts((uri) => [{ uri, text: at }]));
    const kept = await applyMcpReadResource(depsOf(client, cap), params, capture().context);
    if (!kept.ok) throw new Error(kept.error.message);
    expect(kept.value.text).toBe(at);
    expect(kept.value.tokens).toBe(cap);

    const over = await validated(storyScripts((uri) => [{ uri, text: `${at}y` }]));
    const refused = await applyMcpReadResource(depsOf(over.client, cap), over.params, capture().context);
    expect(refused.ok).toBe(false);
  });

  it('names a resource the server does not have as one not-found, whichever code it used', async () => {
    const { client, params } = await validated(storyScripts(TEXT, { fail: (phase) => { if (phase === 'read') throw new WireError('not-found', 'no such resource'); } }));
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error).toMatchObject({ code: 'not-found', target: MARA.uri });
    expect(outcome.error.message).toBe(`'${MARA.uri}' was not found on server 'Story Bible' — the server may have moved or removed it; pick it again from the list`);
  });

  it('refuses an input_required answer by naming the server, and does not demote it', async () => {
    const { client, params } = await validated(storyScripts(TEXT, { fail: (phase) => { if (phase === 'read') throw new WireError('input-required', 'needs input'); } }));
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.message).toBe("server 'Story Bible' asked for more input before it would answer, which Caotang cannot give yet — nothing was read");
    expect(client.healthOf(STORY_KEY)?.state).toBe('healthy');
  });

  it('names an unreachable server, and demotes it as a failed call does', async () => {
    const { client, params } = await validated(storyScripts(TEXT, { fail: (phase) => { if (phase === 'read') throw new WireError('network', 'connection reset'); } }));
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.message).toBe(unreachableText('Story Bible'));
    expect(client.healthOf(STORY_KEY)?.state).toBe('configured');
  });

  it('checks again after listing again: a template that changed after the writer clicked is refused, and nothing is read', async () => {
    const scripts = storyScripts(TEXT);
    const reads: string[] = [];
    const story = scripts[STORY_KEY];
    if (story === undefined) throw new Error('fixture script missing');
    story.record = (event) => {
      if (event.phase === 'read') reads.push(event.tool ?? '');
    };
    const { client, params } = await validated(scripts, { ...PICK, uri: 'wiki://bible/x', viaTemplate: PAGE.uriTemplate });
    story.templates = [{ ...PAGE, description: 'Changed between the click and the read.' }];
    const { context, reports } = capture();
    const outcome = await applyMcpReadResource(depsOf(client), params, context);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('permission-denied');
    expect(reads).toEqual([]);
    expect(reports[0]?.summary).toContain('refused Story Bible');
  });

  it('refuses a URI the server stopped listing between the click and the read', async () => {
    const scripts = storyScripts(TEXT);
    const { client, params } = await validated(scripts);
    const story = scripts[STORY_KEY];
    if (story === undefined) throw new Error('fixture script missing');
    story.resources = [];
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('refuses when the server cannot list its resources any more, and reads nothing', async () => {
    const scripts = storyScripts(TEXT);
    const { client, params } = await validated(scripts);
    const story = scripts[STORY_KEY];
    if (story === undefined) throw new Error('fixture script missing');
    story.fail = (phase) => {
      if (phase === 'resources') throw new WireError('protocol', 'index rebuilding');
    };
    const outcome = await applyMcpReadResource(depsOf(client), params, capture().context);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});

/** The bus's closed set holds `mcp.readResource`; these helpers run the real pipeline with this registration in its slot. */
function pipelineFor(registration: McpReadResourceRegistration) {
  const registry = {
    ...buildRegistry(),
    'mcp.readResource': { descriptor: registration.descriptor, apply: registration.apply },
  } as unknown as CommandRegistry;
  const log = createActivityLog();
  const bus: BusContext<never> = {
    state: undefined as never,
    view: createViewState(),
    read: () => ({}) as ValidationSnapshot,
    undo: createUndoStore(),
    log,
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  return { registry, bus, log };
}

function commandFor(params: Record<string, unknown>, issuedBy: 'user' | 'agent', callId: string): Command {
  return { id: `cmd_${callId}`, name: 'mcp.readResource', params, issuedBy, turnId: 'turn-1', callId, createdAt: 0 };
}

describe('through the bus: only the writer reads a resource', () => {
  async function wired() {
    const scripts = storyScripts(TEXT);
    const reads: string[] = [];
    const story = scripts[STORY_KEY];
    if (story === undefined) throw new Error('fixture script missing');
    story.record = (event) => {
      if (event.phase === 'read') reads.push(event.tool ?? '');
    };
    const { client } = await openClient({ scripts, approve: [STORY_KEY] });
    const registration = mcpReadResourceRegistration(depsOf(client));
    return { registration, reads, ...pipelineFor(registration) };
  }

  it('declares the closure: agentRisk never, no undo, an external row, an awaited apply', async () => {
    const { registration } = await wired();
    expect(registration.descriptor).toMatchObject({ mutates: 'none', agentRisk: 'never', undo: 'none', activitySource: 'mcp', asyncApply: true });
    expect(registration.descriptor.agentRiskOf).toBeUndefined();
    expect(registration.source).toBe('mcp');
  });

  it('refuses an agent that sends it, even with pickedBy: "writer", and the server is never reached', async () => {
    const { registry, bus, reads, log } = await wired();
    const result = await executeAsync(commandFor(PICK, 'agent', 'agent-1'), bus, registry, 'mcp');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('permission-denied');
    expect(result.error.risk).toBe('never');
    expect(reads).toEqual([]);
    expect(log.entries()).toHaveLength(0);
  });

  it('refuses the writer\'s own command when it does not carry pickedBy: "writer"', async () => {
    const { registry, bus, reads } = await wired();
    const result = await executeAsync(commandFor({ serverKey: STORY_KEY, uri: MARA.uri }, 'user', 'user-1'), bus, registry, 'mcp');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('permission-denied');
    expect(reads).toEqual([]);
  });

  it('reads for the writer, writes one row under source mcp, and returns the untrusted resource', async () => {
    const { registry, bus, reads, log } = await wired();
    const result = await executeAsync(commandFor(PICK, 'user', 'user-2'), bus, registry, 'native');
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.result).toMatchObject({ untrusted: true, source: { serverKey: STORY_KEY, uri: MARA.uri } });
    expect(reads).toEqual([MARA.uri]);
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ command: 'mcp.readResource', source: 'mcp', summary: 'read Story Bible › wiki://bible/mara (external resource)' });
  });

  it('is refused through the synchronous bus before its apply runs, naming executeAsync', async () => {
    const { registry, bus, reads } = await wired();
    const result = execute(commandFor(PICK, 'user', 'user-3'), bus, registry, 'mcp');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.message).toContain('executeAsync');
    expect(reads).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('rejects the apply with the failure the bus reports, so a refusal is never a completed command', async () => {
    const { client } = await openClient({ scripts: storyScripts((uri) => [{ uri, mimeType: 'image/png', blob: 'AAAA' }]), approve: [STORY_KEY] });
    const registration = mcpReadResourceRegistration(depsOf(client));
    const { registry, bus, log } = pipelineFor(registration);
    const result = await executeAsync(commandFor(PICK, 'user', 'user-4'), bus, registry, 'mcp');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.message).toContain('image/png');
    // A refusal that reached the apply still has its row, so the writer can see what was attempted.
    expect(log.entries()[0]?.summary).toContain('image/png blob');
    const params: McpReadResourceNormalized = { serverKey: STORY_KEY, uri: MARA.uri, pickedBy: 'writer', serverName: 'Story Bible' };
    await expect(registration.apply(undefined as never, params, { report: () => undefined } as unknown as ApplyContext)).rejects.toBeInstanceOf(McpReadResourceFailure);
  });
});
