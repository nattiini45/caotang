/**
 * Recovery from the MCP server (project-format §5, extensibility §9): a folder whose caotang.json will not load starts the server in a
 * degraded state that offers the store's ladder through `project.recover` and `project.recoverApply`, and refuses everything else.
 * Every host here is a mock: the SDK's own client, answering the confirmation as a person would.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRefusedError } from '@caotang/store';

import {
  ProjectLockedError,
  RECOVER_APPLY_TOOL,
  RECOVER_TOOL,
  argsDigest,
  openProject,
  openProjectOrOffer,
} from '../src/index.js';
import {
  CORRUPT_MANIFEST,
  CORRUPT_MARKER,
  HAND_WRITTEN_DOC,
  HAND_WRITTEN_DOC_NAME,
  LANDING,
  LANDING_BODY,
  acceptConfirm,
  brokenFolder,
  cancelConfirm,
  connectClient,
  declineConfirm,
  folderBytes,
  removeDir,
  resultJson,
  seedProject,
  startDegraded,
  startOver,
  tempDir,
  resend,
  type Answer,
  type DegradedFixture,
  type Exchange,
} from './support.js';

const LOCK = '.caotang-mcp.lock';

/** Everything in the folder but the lock the degraded server holds: the project's own observable state. */
function projectBytes(root: string): Record<string, string> {
  const { [LOCK]: _lock, ...rest } = folderBytes(root);
  return rest;
}

/** The `caotang.json.corrupt-*` copies in a folder. */
function corruptCopies(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith('caotang.json.corrupt-'));
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** A degraded server over a broken folder, closed and removed after the test. */
async function degradedOver(root: string, allowWrites: boolean): Promise<DegradedFixture> {
  const fixture = await startDegraded(root, allowWrites);
  cleanup.push(async () => {
    await fixture.stop();
    removeDir(root);
  });
  return fixture;
}

/** The refusal in a tool result that has `isError` set. */
function errorOf(result: { content: readonly unknown[]; isError?: boolean }): { code: string; message: string; correctiveHint?: string } {
  expect(result.isError).toBe(true);
  return resultJson(result)['error'] as { code: string; message: string; correctiveHint?: string };
}

describe('a folder whose caotang.json will not parse starts the server degraded, and offers the ladder', () => {
  it('holds the lock, writes nothing, and shows the snapshot it would restore from, without the unreadable bytes', async () => {
    const root = await brokenFolder('rec-offer', 'snapshot');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);

    expect(existsSync(join(root, LOCK))).toBe(true);
    const client = await connectClient(fixture.url, fixture.token);
    const shown = resultJson(await client.callTool({ name: RECOVER_TOOL, arguments: {} }));
    const data = shown['data'] as Record<string, unknown>;
    expect(data).toMatchObject({
      status: 'offer',
      source: { kind: 'snapshot', path: 'caotang.json.bak.1', generation: 1, file: 'caotang.json.bak.1' },
      requiresConsent: false,
      loss: [],
      canApply: true,
    });

    // The offer carries file names and counts. The unreadable manifest's bytes and a document's text are not in it.
    const text = JSON.stringify(shown);
    expect(text).not.toContain(CORRUPT_MARKER);
    expect(text).not.toContain(LANDING_BODY);
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('shows a rebuild as needing consent, and lists everything it loses', async () => {
    const root = await brokenFolder('rec-rebuild-offer', 'rebuild');
    const fixture = await degradedOver(root, true);
    const client = await connectClient(fixture.url, fixture.token);

    const data = resultJson(await client.callTool({ name: RECOVER_TOOL, arguments: {} }))['data'] as { loss: string[] };
    expect(data).toMatchObject({ status: 'offer', source: { kind: 'rebuild' }, requiresConsent: true, recoveredDocuments: 1 });
    expect(data.loss).toHaveLength(4);
    expect(data.loss.join(' ')).toContain('Folder structure');
    expect(data.loss.join(' ')).toContain('Vocabulary');
    await client.close();
  });

  it('reports a file whose bytes are not UTF-8 by name, and leaves it as it is', async () => {
    const root = await brokenFolder('rec-encoding', 'rebuild');
    writeFileSync(join(root, 'docs', 'n_7K2QX9M4B1.md'), Buffer.from([0x54, 0x68, 0x65, 0x20, 0xe9, 0x74, 0xe9, 0x0a]));
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);
    const client = await connectClient(fixture.url, fixture.token);

    const data = resultJson(await client.callTool({ name: RECOVER_TOOL, arguments: {} }))['data'] as { encodingIssues: { file: string }[] };
    expect(data.encodingIssues.map((issue) => issue.file)).toContain('docs/n_7K2QX9M4B1.md');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('lists exactly project.recover read-only, and adds project.recoverApply only with --allow-writes', async () => {
    const readOnly = await degradedOver(await brokenFolder('rec-list-ro', 'snapshot'), false);
    const roClient = await connectClient(readOnly.url, readOnly.token);
    expect((await roClient.listTools()).tools.map((tool) => tool.name)).toEqual([RECOVER_TOOL]);
    await roClient.close();

    const writes = await degradedOver(await brokenFolder('rec-list-rw', 'snapshot'), true);
    const rwClient = await connectClient(writes.url, writes.token);
    const tools = (await rwClient.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([RECOVER_TOOL, RECOVER_APPLY_TOOL]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools[1]?.description?.startsWith('Requires user confirmation.')).toBe(true);
    await rwClient.close();
  });

  it('says in its instructions that the project is not open, and what to do', async () => {
    const fixture = await degradedOver(await brokenFolder('rec-instructions', 'snapshot'), false);
    const client = await connectClient(fixture.url, fixture.token);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('could not be opened');
    expect(instructions).toContain(RECOVER_TOOL);
    expect(instructions).toContain('--allow-writes');
    await client.close();
  });

  it('refuses a recovery write on a read-only server, naming the flag, and writes nothing', async () => {
    const root = await brokenFolder('rec-readonly', 'snapshot');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, false);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} }));
    expect(refusal.code).toBe('permission-denied');
    expect(refusal.message).toContain('--allow-writes');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('refuses every other tool as a tool result that says to recover first, and runs nothing', async () => {
    const root = await brokenFolder('rec-others', 'snapshot');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);

    for (const name of ['project.overview', 'doc.read', 'meta.set', 'doc.import', 'export.compile', 'not.a.tool']) {
      const refusal = errorOf(await client.callTool({ name, arguments: {} }));
      expect(refusal.message).toContain('this project could not be opened; recover it first');
      expect(refusal.correctiveHint).toContain(RECOVER_TOOL);
    }
    // The bus's hard-deny is still the bus's own words.
    expect(errorOf(await client.callTool({ name: 'project.deleteNode', arguments: {} })).code).toBe('hard-denied');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });
});

describe('an unrecoverable folder gets the honest bound and no write tool', () => {
  it('says there is no readable copy, lists only project.recover even with writes on, and writes nothing', async () => {
    const root = await brokenFolder('rec-bare', 'bare');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([RECOVER_TOOL]);
    const shown = resultJson(await client.callTool({ name: RECOVER_TOOL, arguments: {} }));
    expect(shown['summary']).toBe(
      'Caotang could not find a readable copy of this project. caotang.json cannot be read, and there is no backup or document file to rebuild it from.',
    );
    expect(shown['data']).toMatchObject({ status: 'unrecoverable', canApply: false });
    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} }));
    expect(refusal.message).toContain('there is nothing to recover from');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });
});

describe('a manifest this build refuses is refused outright', () => {
  it.each([
    ['a newer format', { formatVersion: 2 }],
    ['another app', { app: 'other' }],
  ])('%s: no ladder, no offer, no write, and the lock is released', async (_label, change) => {
    const root = tempDir('rec-refused');
    cleanup.push(() => removeDir(root));
    await seedProject(root, 'Refused Book');
    const path = join(root, 'caotang.json');
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as object), ...change }, null, 2));
    const before = folderBytes(root);

    await expect(openProjectOrOffer({ root, allowWrites: true })).rejects.toBeInstanceOf(ProjectRefusedError);
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });
});

describe('the strict open and the lock', () => {
  it('openProject still throws for an unreadable manifest, and a second writer is refused while the degraded server holds the folder', async () => {
    const root = await brokenFolder('rec-strict', 'snapshot');
    await expect(openProject({ root, allowWrites: false })).rejects.toThrow();
    const fixture = await degradedOver(root, false);
    await expect(openProjectOrOffer({ root, allowWrites: false })).rejects.toBeInstanceOf(ProjectLockedError);
    await fixture.stop();
    expect(existsSync(join(root, LOCK))).toBe(false);
  });

  it('--create does not replace a manifest that exists: the folder is offered its recovery instead', async () => {
    const root = await brokenFolder('rec-create', 'snapshot');
    const before = projectBytes(root);
    cleanup.push(() => removeDir(root));
    const session = await openProjectOrOffer({ root, create: 'A New Book', allowWrites: true });
    expect('degraded' in session).toBe(true);
    await session.close();
    expect(projectBytes(root)).toEqual(before);
  });

  it('a folder with no caotang.json at all, but documents, still refuses --create as it did', async () => {
    const root = await brokenFolder('rec-create-missing', 'bare');
    rmSync(join(root, 'caotang.json'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', HAND_WRITTEN_DOC_NAME), HAND_WRITTEN_DOC);
    cleanup.push(() => removeDir(root));
    await expect(openProjectOrOffer({ root, create: 'A New Book', allowWrites: true })).rejects.toThrow('Open this folder in Caotang');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// project.recoverApply
// ---------------------------------------------------------------------------------------------------------------------------------

/** An answer that records the question and then replies. */
function recording(reply: Answer, asked: string[]): Answer {
  return (params) => {
    asked.push(params.message);
    return reply(params);
  };
}

describe('project.recoverApply restores a snapshot after the host’s yes', () => {
  it('asks naming the exact source file, the preserved copy and the lock, with no title or text; then writes, keeps the corrupt original, and serves the project after a restart', async () => {
    const root = await brokenFolder('rec-apply', 'snapshot');
    const snapshot = readFileSync(join(root, 'caotang.json.bak.1'), 'utf8');
    const fixture = await degradedOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(fixture.url, fixture.token, recording(acceptConfirm, asked));

    const result = await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} });
    expect(result.isError).toBeFalsy();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('caotang.json.bak.1');
    expect(asked[0]).toContain('caotang.json.corrupt-<timestamp>');
    expect(asked[0]).toContain('holds the folder lock');
    expect(asked[0]).not.toContain('The Landing');
    expect(asked[0]).not.toContain(LANDING_BODY);
    expect(asked[0]).not.toContain(CORRUPT_MARKER);

    const done = resultJson(result);
    expect(done['summary']).toContain('caotang.json.bak.1');
    expect(done['data']).toMatchObject({ status: 'recovered', restartRequired: true });

    // The corrupt original is kept under its timestamped name, and was not rotated into the snapshots.
    const [kept] = corruptCopies(root);
    expect(corruptCopies(root)).toHaveLength(1);
    expect(readFileSync(join(root, kept ?? ''), 'utf8')).toBe(CORRUPT_MANIFEST);
    expect(existsSync(join(root, 'caotang.json.bak.1'))).toBe(true);
    expect(readFileSync(join(root, 'caotang.json.bak.1'), 'utf8')).not.toContain(CORRUPT_MARKER);
    expect(readFileSync(join(root, 'caotang.json'), 'utf8')).toContain('The Lighthouse Keeper');
    expect(readFileSync(join(root, 'caotang.json'), 'utf8')).not.toContain('second save');
    expect(snapshot).toContain('The Lighthouse Keeper');
    expect(existsSync(join(root, LOCK))).toBe(false);
    expect(fixture.reports.join('\n')).toContain('recovered the project from caotang.json.bak.1');

    // The server holds no project now: every tool says so, a replay of the accepted retry gets the first answer.
    const after = errorOf(await client.callTool({ name: 'project.overview', arguments: {} }));
    expect(after.message).toContain('recovered; restart or reconnect the server to open the project');
    expect(errorOf(await client.callTool({ name: RECOVER_TOOL, arguments: {} })).message).toContain('recovered; restart or reconnect');
    await client.close();
    await fixture.stop();

    // A restart opens the recovered project and serves it normally.
    const restarted = await startOver(root, false);
    const overview = await connectClient(restarted.url, restarted.token);
    const body = resultJson(await overview.callTool({ name: 'project.overview', arguments: {} }));
    expect(JSON.stringify(body)).toContain('The Lighthouse Keeper');
    await overview.close();
    await restarted.stop();
  });

  it('writes nothing when the host declines, or cancels, and the offer stands for a later yes', async () => {
    const root = await brokenFolder('rec-decline', 'snapshot');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);

    for (const reply of [declineConfirm, cancelConfirm]) {
      const client = await connectClient(fixture.url, fixture.token, reply);
      const result = await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ written: false });
      expect(projectBytes(root)).toEqual(before);
      await client.close();
    }
    expect(fixture.session.phase).toBe('offered');

    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    expect((await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} })).isError).toBeFalsy();
    expect(corruptCopies(root)).toHaveLength(1);
    await client.close();
  });

  it('refuses a host that cannot be asked, names the desktop app, and writes nothing', async () => {
    const root = await brokenFolder('rec-noelicit', 'snapshot');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);
    const client = await connectClient(fixture.url, fixture.token);

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} }));
    expect(refusal.code).toBe('permission-denied');
    expect(refusal.message).toContain('needs your confirmation');
    expect(refusal.correctiveHint).toContain('Caotang desktop app');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('refuses rebuild: true for an offer that is a snapshot restore, and asks nothing', async () => {
    const root = await brokenFolder('rec-notrebuild', 'snapshot');
    const fixture = await degradedOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(fixture.url, fixture.token, recording(acceptConfirm, asked));

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } }));
    expect(refusal.message).toContain('not a rebuild');
    expect(asked).toHaveLength(0);
    expect(corruptCopies(root)).toHaveLength(0);
    await client.close();
  });

  it('refuses an argument it does not know, and a rebuild that is not a boolean', async () => {
    const fixture = await degradedOver(await brokenFolder('rec-args', 'snapshot'), true);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    expect(errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { force: true } })).code).toBe('invalid-params');
    expect(errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: 'yes' } })).code).toBe('invalid-params');
    expect(corruptCopies(fixture.root)).toHaveLength(0);
    await client.close();
  });
});

describe('an accepted retry is one recovery', () => {
  it('sent again after the recovery, it is answered as before, and a second one in flight at once waits for the first', async () => {
    const root = await brokenFolder('rec-replay', 'snapshot');
    const fixture = await degradedOver(root, true);
    const exchanges: Exchange[] = [];
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm, exchanges);

    const first = await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} });
    expect(first.isError).toBeFalsy();
    const retry = exchanges.find((exchange) => exchange.body.includes('"inputResponses"'));
    if (retry === undefined) throw new Error('the client sent no accepted retry');

    const [again, concurrent] = await Promise.all([resend(retry), resend(retry)]);
    expect((again['result'] as { isError?: boolean }).isError).not.toBe(true);
    expect(concurrent['result']).toEqual(again['result']);
    expect(corruptCopies(root)).toHaveLength(1);
    await client.close();
  });

  it('two accepts of one round racing before the recovery is written make one recovery', async () => {
    const root = await brokenFolder('rec-race', 'snapshot');
    const fixture = await degradedOver(root, true);
    const exchanges: Exchange[] = [];
    // A declined round leaves its question open; asking again gives a fresh state, which the two accepts below share.
    const client = await connectClient(fixture.url, fixture.token, declineConfirm, exchanges);
    await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} });
    const initial = exchanges.find((exchange) => exchange.body.includes('"tools/call"') && !exchange.body.includes('"inputResponses"'));
    if (initial === undefined) throw new Error('the client sent no initial call');
    const asked = (await resend(initial))['result'] as { requestState?: string };
    if (typeof asked.requestState !== 'string') throw new Error('the server asked nothing for the initial call');
    const body = JSON.parse(initial.body) as { params: Record<string, unknown> };
    body.params['inputResponses'] = { confirm: { action: 'accept', content: { confirmed: true } } };
    body.params['requestState'] = asked.requestState;
    const accept = JSON.stringify(body);

    const [one, two] = await Promise.all([resend(initial, accept), resend(initial, accept)]);
    expect(two['result']).toEqual(one['result']);
    expect((one['result'] as { isError?: boolean }).isError).not.toBe(true);
    expect(corruptCopies(root)).toHaveLength(1);
    await client.close();
  });
});

describe('a rebuild needs its own yes', () => {
  it('a call without rebuild: true is refused with the loss named, asks nothing, and writes nothing', async () => {
    const root = await brokenFolder('rec-rebuild-refused', 'rebuild');
    const before = projectBytes(root);
    const fixture = await degradedOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(fixture.url, fixture.token, recording(acceptConfirm, asked));

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} }));
    expect(refusal.code).toBe('invalid-params');
    expect(refusal.message).toContain('Folder structure');
    expect(refusal.message).toContain('Vocabulary');
    expect(refusal.correctiveHint).toContain('"rebuild": true');
    expect(asked).toHaveLength(0);
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('with rebuild: true the question names the loss, and a yes writes a rebuilt project beside the kept original', async () => {
    const root = await brokenFolder('rec-rebuild', 'rebuild');
    const fixture = await degradedOver(root, true);
    const asked: string[] = [];
    const client = await connectClient(fixture.url, fixture.token, recording(acceptConfirm, asked));

    const result = await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } });
    expect(result.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('rebuild this project from the front matter');
    expect(asked[0]).toContain('Folder structure');
    expect(asked[0]).toContain('Vocabulary');
    expect(asked[0]).toContain('caotang.json.corrupt-<timestamp>');
    expect(asked[0]).not.toContain('The Landing');

    expect(corruptCopies(root)).toHaveLength(1);
    expect(readFileSync(join(root, 'caotang.json'), 'utf8')).toContain('Recovered');
    expect(readFileSync(join(root, 'docs', `${LANDING}.md`), 'utf8')).toContain(LANDING_BODY);
    await client.close();
    await fixture.stop();
    const reopened = await openProject({ root, allowWrites: false });
    expect(reopened.state.documents.get(LANDING)?.body).toBe(LANDING_BODY);
    await reopened.close();
  });

  it('a yes is bound to its arguments: the rebuild’s digest is not the plain call’s', () => {
    expect(argsDigest(RECOVER_APPLY_TOOL, { rebuild: true })).not.toBe(argsDigest(RECOVER_APPLY_TOOL, {}));
  });
});

describe('the folder is checked against what the offer read, at the question and at the accept', () => {
  it('a caotang.json changed after the offer: the call is refused before any question, and nothing is written', async () => {
    const root = await brokenFolder('rec-drift-manifest', 'snapshot');
    const fixture = await degradedOver(root, true);
    writeFileSync(join(root, 'caotang.json'), `${CORRUPT_MANIFEST} "edited by another program"`);
    const before = projectBytes(root);
    const asked: string[] = [];
    const client = await connectClient(fixture.url, fixture.token, recording(acceptConfirm, asked));

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: {} }));
    expect(refusal.message).toContain('changed or removed caotang.json');
    expect(asked).toHaveLength(0);
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('a document changed after the offer: refused, nothing written, the document named by its title', async () => {
    const root = await brokenFolder('rec-drift-doc', 'rebuild');
    const fixture = await degradedOver(root, true);
    appendFileSync(join(root, 'docs', `${LANDING}.md`), 'A line another program wrote.\n');
    const before = projectBytes(root);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } }));
    expect(refusal.message).toContain('changed the document “The Landing”');
    expect(projectBytes(root)).toEqual(before);
    expect(corruptCopies(root)).toHaveLength(0);
    await client.close();
  });

  it('a codex file changed after the offer: refused, nothing written, the entry named', async () => {
    const root = await brokenFolder('rec-drift-codex', 'rebuild', { codex: true });
    const fixture = await degradedOver(root, true);
    const codexFile = readdirSync(join(root, 'codex'))[0] ?? '';
    appendFileSync(join(root, 'codex', codexFile), 'Another program added this.\n');
    const before = projectBytes(root);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } }));
    expect(refusal.message).toContain('changed the codex entry');
    expect(projectBytes(root)).toEqual(before);
    await client.close();
  });

  it('a document added after the offer is named too', async () => {
    const root = await brokenFolder('rec-drift-added', 'rebuild');
    const fixture = await degradedOver(root, true);
    writeFileSync(join(root, 'docs', HAND_WRITTEN_DOC_NAME), HAND_WRITTEN_DOC);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } }));
    expect(refusal.message).toContain('added a document');
    expect(corruptCopies(root)).toHaveLength(0);
    await client.close();
  });

  it('a file changed while the question is open: the accept finds it, writes nothing, and names it', async () => {
    const root = await brokenFolder('rec-drift-accept', 'rebuild');
    const fixture = await degradedOver(root, true);
    const during: Answer = () => {
      appendFileSync(join(root, 'docs', `${LANDING}.md`), 'Edited while the dialog was open.\n');
      return { action: 'accept', content: { confirmed: true } };
    };
    const client = await connectClient(fixture.url, fixture.token, during);

    const refusal = errorOf(await client.callTool({ name: RECOVER_APPLY_TOOL, arguments: { rebuild: true } }));
    expect(refusal.message).toContain('The Landing');
    expect(corruptCopies(root)).toHaveLength(0);
    expect(readFileSync(join(root, 'caotang.json'), 'utf8')).toBe(CORRUPT_MANIFEST);
    expect(fixture.session.phase).toBe('offered');
    await client.close();
  });
});
