/**
 * The host-model pairs (agent-harness §3, "External-only rows"): `scene.brief` and `dialogue.brief` return what the in-app tool would
 * send its model, and `scene.apply` and `dialogue.apply` run the host's reply through the in-app ports. The golden half runs the agent
 * loop on a mock provider and holds the brief to the messages that provider received. It pins the first-turn case: a fresh session, the
 * default context budgets and no skill loaded. A later turn adds the earlier-turns layer and a loaded skill adds its block.
 */

import { draftScript, userTextOf } from '@caotang/gateway/mock';
import type { ChatMessage } from '@caotang/gateway';
import { describe, expect, it } from 'vitest';

import { addDocument, getBody, getRevision, type ProjectState } from '@caotang/store';

import {
  BRIEF_CAP,
  BRIEF_TTL_MS,
  briefRefusal,
  createAgentPorts,
  createAgentSession,
  createBriefLedger,
  createBriefPorts,
  createContextPort,
  createHarness,
  createProductHarness,
  draftModeRefusal,
  metadataFor,
  plannerTools,
  TOOL_METADATA,
  type Harness,
  type RulesProvider,
} from '../src/index.js';
import { dialogueRole, sceneRole } from '../src/agent/drafting.js';
import { heldBrief } from '../src/tools/briefs.js';
import { OPENED, clock, FRIEND, LANDING, STORM, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';
import { mockGateway } from './agent/gateway.js';
import { steps, transcript } from './agent/scripts.js';

const TAVERN = 'n_TAVERN0001';
const INK = ['=== reply ===', 'Thanks for the drink.', '-> END'].join('\n');
const OTHER_INK = ['=== other ===', 'Hello.', '-> END'].join('\n');
const INSTRUCTIONS ='British spelling. Elena never swears.';

/** The fixture project, with the writer's CAOTANG.md and a dialogue container, so the briefs carry the layers a real project has. */
function project(): ProjectState {
  const state = makeState();
  state.agentFiles = { instructions: { path: 'CAOTANG.md', text: INSTRUCTIONS }, memory: [], declined: new Map(), unreadable: [] };
  addDocument(state, { id: TAVERN, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: '', now: OPENED });
  return state;
}

function hostOf(state: ProjectState, rules?: RulesProvider, ledger = createBriefLedger({ now: () => clock.now() })) {
  const harness = createProductHarness({
    state,
    ports: 'external',
    externalWrites: true,
    externalPorts: createBriefPorts({ ledger }),
    clock: clock.now,
    ...(rules === undefined ? {} : { rules }),
  });
  return { harness, ledger };
}

/** A brief, as an external host asks for it. */
function brief(harness: Harness, name: string, params: Record<string, unknown>) {
  return valueOf(harness.external.call({ name, callId: `brief-${Math.random()}`, params }, { turnId: 'mcp-turn' }));
}

/** An apply, as the host's confirmation lets it through. */
function apply(harness: Harness, name: string, params: Record<string, unknown>) {
  return run(harness, name, params, { permission: { confirmed: true } });
}

interface Brief {
  readonly briefId: string;
  readonly messages: ChatMessage[];
  readonly applyWith: Record<string, unknown>;
  readonly droppedContext: string[];
  readonly framing: string;
  readonly expiresAt: string;
}

const briefOf = (data: unknown): Brief => data as Brief;

describe('the brief ledger', () => {
  it('mints a b_ handle that carries its kind, focus and revision, and holds it for 30 minutes', () => {
    let at = 1_000;
    const ledger = createBriefLedger({ now: () => at });
    const record = ledger.mint({ kind: 'scene', focus: LANDING, revision: 3, digest: 'd' });
    expect(record.id).toMatch(/^b_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(record.expiresAt).toBe(1_000 + BRIEF_TTL_MS);
    expect(ledger.recall(record.id, 'scene')).toMatchObject({ ok: true, value: { focus: LANDING, revision: 3 } });
    at += BRIEF_TTL_MS - 1;
    expect(ledger.recall(record.id, 'scene').ok).toBe(true);
    at += 1;
    const expired = ledger.recall(record.id, 'scene');
    expect(expired.ok).toBe(false);
    expect(!expired.ok && expired.error.message).toContain('expired after 30 minutes');
  });

  it('refuses an id it did not mint, and a brief of the other kind, with the tool to ask again', () => {
    const ledger = createBriefLedger();
    const unknown = ledger.recall('b_0000000000', 'scene');
    expect(!unknown.ok && unknown.error.message).toContain('is not one this server holds');
    expect(!unknown.ok && unknown.error.correctiveHint).toContain('scene.brief');
    const record = ledger.mint({ kind: 'dialogue', focus: TAVERN, revision: 0, digest: 'd' });
    const wrong = ledger.recall(record.id, 'scene');
    expect(!wrong.ok && wrong.error.message).toContain('is a dialogue brief');
  });

  it('quotes the lifetime it was given in its refusals, not the default', () => {
    let at = 0;
    const ledger = createBriefLedger({ now: () => at, ttlMs: 2 * 60_000 });
    const record = ledger.mint({ kind: 'scene', focus: LANDING, revision: 0, digest: 'd' });
    expect(record.expiresAt).toBe(2 * 60_000);
    at = 2 * 60_000;
    const expired = ledger.recall(record.id, 'scene');
    expect(!expired.ok && expired.error.message).toContain('expired after 2 minutes');
    const unknown = ledger.recall('b_0000000000', 'scene');
    expect(!unknown.ok && unknown.error.message).toContain('held in memory for 2 minutes');
  });

  it('holds at most its cap, letting the oldest go first, and drops expired briefs when it mints', () => {
    let at = 0;
    const ledger = createBriefLedger({ now: () => at, cap: 3 });
    const ids = [0, 1, 2, 3].map(() => ledger.mint({ kind: 'scene', focus: LANDING, revision: 0, digest: 'd' }).id);
    expect(ledger.size).toBe(3);
    expect(ledger.recall(ids[0] as string, 'scene').ok).toBe(false);
    expect(ledger.recall(ids[3] as string, 'scene').ok).toBe(true);
    at = BRIEF_TTL_MS;
    ledger.mint({ kind: 'scene', focus: LANDING, revision: 0, digest: 'd' });
    expect(ledger.size).toBe(1);
    expect(BRIEF_CAP).toBe(64);
  });

  it('keeps a digest of the messages, never the messages', () => {
    const { harness, ledger } = hostOf(project());
    const data = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Open on the ferry.', mode: 'continue' }).data);
    const record = ledger.recall(data.briefId, 'scene');
    expect(record.ok && JSON.stringify(record.value)).not.toContain('ferry');
  });
});

describe('the registry column', () => {
  const rows = TOOL_METADATA.filter((meta) => meta.externalOnly === true).map((meta) => meta.name);

  it('marks the four host-model rows external-only, and the apply rows write-confirm', () => {
    expect(rows).toEqual(['scene.brief', 'scene.apply', 'dialogue.brief', 'dialogue.apply']);
    expect(rows.map((name) => metadataFor(name)?.risk)).toEqual(['read', 'write-confirm', 'read', 'write-confirm']);
    for (const name of rows) expect(metadataFor(name), name).toMatchObject({ surface: 'extension', load: 'deferred' });
    expect(metadataFor('scene.brief')?.mirrors).toBe('scene.draft');
    expect(metadataFor('dialogue.apply')?.mirrors).toBe('dialogue.draft');
  });

  it('ties every external-only row to the in-app row it mirrors, which is itself in-app', () => {
    for (const meta of TOOL_METADATA.filter((entry) => entry.externalOnly === true)) {
      expect(meta.mirrors, meta.name).toBeDefined();
      expect(metadataFor(meta.mirrors!)?.externalOnly, `${meta.name} mirrors ${meta.mirrors}`).toBeUndefined();
    }
  });

  it('is not offered to the in-app planner, even with every tool loaded, and not found by tool.search', () => {
    const app = createHarness({ state: project(), ports: createAgentPorts(), clock: clock.now });
    expect(plannerTools(app.tools(), { all: true }).map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['scene.brief']));
    for (const name of rows) expect(plannerTools(app.tools(), { all: true }).map((tool) => tool.name), name).not.toContain(name);

    // On a host that wires the ports, the rows are still not the planner's and not the search's.
    const { harness } = hostOf(project());
    expect(harness.tools().filter((tool) => tool.externalOnly === true && tool.wired).map((tool) => tool.name)).toEqual(rows);
    for (const name of rows) expect(plannerTools(harness.tools(), { all: true }).map((tool) => tool.name), name).not.toContain(name);
    const found = valueOf(run(harness, 'tool.search', { query: 'brief apply scene dialogue draft host' }));
    expect(JSON.stringify(found.data)).not.toMatch(/scene\.(brief|apply)|dialogue\.(brief|apply)/);
    harness.preload('turn-preload', rows);
    expect(harness.loadedNativeTools().map((tool) => tool.name)).toEqual([]);
  });

  it('leaves the rows unwired where no ledger is supplied: the app, the SDK and a bare harness', () => {
    const app = createProductHarness({ state: project(), ports: 'agent', externalPorts: createBriefPorts({ ledger: createBriefLedger() }) });
    const plain = createProductHarness({ state: project(), ports: 'external' });
    for (const harness of [app, plain]) {
      for (const name of rows) expect(harness.tools().find((tool) => tool.name === name)?.wired, name).toBe(false);
    }
  });
});

describe('a brief is what the in-app tool sends its model', () => {
  /** The messages the agent loop sent the mock provider for one planned step, and the state it drafted from. */
  async function inApp(step: { tool: string; params: Record<string, unknown> }, marker: string) {
    const seen: ChatMessage[][] = [];
    const state = project();
    const intent = 'Draft it.';
    const gateway = await mockGateway([
      transcript(intent, [steps({ tool: step.tool, params: step.params, expect: 'the draft is written' })]),
      draftScript((req) => {
        if (req.responseFormat === 'text' && userTextOf(req).includes(marker)) {
          seen.push([...req.messages]);
          return step.tool === 'dialogue.draft' ? INK : 'Rain, then more rain.';
        }
        return undefined;
      }),
    ]);
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'approve' }), sessionId: 'golden' });
    await session.submit(intent);
    // The loop may ask again after a retry of the card; every call it made is the same message list.
    expect(seen.length).toBeGreaterThan(0);
    for (const sent of seen) expect(sent).toEqual(seen[0]);
    return seen[0] as ChatMessage[];
  }

  it.each<[string, Record<string, unknown>, string]>([
    ['draft', { doc: FRIEND, instruction: 'Open on the ferry.' }, 'Open on the ferry.'],
    ['continue', { doc: LANDING, instruction: 'Elena steps ashore.', mode: 'continue', target_words: 120 }, 'Elena steps ashore.'],
    ['forward outline', { doc: LANDING, instruction: 'Close the chapter.', mode: 'continue', include_forward_outline: true }, 'Close the chapter.'],
  ])('scene.brief, mode %s: the messages are the ones the loop sends', async (_label, params, marker) => {
    const sent = await inApp({ tool: 'scene.draft', params }, marker);
    const { harness } = hostOf(project());
    const data = briefOf(brief(harness, 'scene.brief', params).data);
    expect(data.messages).toEqual(sent);
    expect(data.messages[0]?.content).toBe(sceneRole(params['target_words'] as number | undefined, undefined, (params['mode'] ?? 'draft') as 'draft'));
  });

  it('scene.brief, rewrite_selection: the selection is quoted as the loop quotes it', async () => {
    const selection = { from: 4, to: 9, exact: 'ferry', prefix: 'The ', suffix: ' was', capturedRevision: 0 };
    const params = { doc: LANDING, instruction: 'Make it a boat.', mode: 'rewrite_selection', selection };
    const sent = await inApp({ tool: 'scene.draft', params }, 'Make it a boat.');
    const { harness } = hostOf(project());
    const data = briefOf(brief(harness, 'scene.brief', params).data);
    expect(data.messages).toEqual(sent);
    expect(data.applyWith).toEqual({ doc: LANDING, mode: 'rewrite_selection', selection, briefId: data.briefId });
  });

  it('dialogue.brief: the messages are the ones the loop sends', async () => {
    const params = { doc: TAVERN, instruction: 'A thank-you.', target_lines: 4 };
    const sent = await inApp({ tool: 'dialogue.draft', params }, 'A thank-you.');
    const { harness } = hostOf(project());
    const data = briefOf(brief(harness, 'dialogue.brief', params).data);
    expect(data.messages).toEqual(sent);
    expect(data.messages[0]?.content).toBe(dialogueRole(4));
  });

  it('carries CAOTANG.md and the codex as the in-app assembly does, names itself project data, and says what it dropped', () => {
    const { harness } = hostOf(project());
    const data = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Elena steps ashore.', mode: 'continue' }).data);
    const text = data.messages.map((message) => message.content).join('\n');
    expect(text).toContain(INSTRUCTIONS);
    expect(text).toContain('The keeper.');
    expect(data.framing).toContain('project data');
    expect(data.droppedContext).toEqual(expect.any(Array));
    expect(data.expiresAt).toBe(new Date(clock.now() + BRIEF_TTL_MS).toISOString());
  });

  it('answers the same for a screenplay scene as the loop does: the role names Fountain', () => {
    const state = project();
    addDocument(state, { id: 'n_SCRN000001', parentId: 'manuscript', title: 'Harbour', kind: 'screenplay', body: 'INT. HARBOUR - NIGHT\n\nELENA waits.\n', now: OPENED });
    const { harness } = hostOf(state);
    const data = briefOf(brief(harness, 'scene.brief', { doc: 'Harbour', instruction: 'More.', mode: 'continue' }).data);
    expect(data.messages[0]?.content).toBe(sceneRole(undefined, 'screenplay', 'continue'));
    expect(data.messages[0]?.content).toContain('Fountain');
  });
});

describe('a brief is refused as scene.draft would be, before it is made', () => {
  it('refuses mode draft over a document that has text, with the words the in-app tool uses', () => {
    const { harness } = hostOf(project());
    const error = refusalOf(harness.external.call({ name: 'scene.brief', callId: 'c1', params: { doc: LANDING, instruction: 'Again.' } }, { turnId: 't' }));
    expect(error.message).toBe(draftModeRefusal('draft', getBody(harness.state, LANDING))?.message);
    expect(error.correctiveHint).toContain('mode to continue');
  });

  it('refuses a rewrite with no anchor, and an anchor that cannot be found', () => {
    const { harness } = hostOf(project());
    const none = refusalOf(harness.external.call({ name: 'scene.brief', callId: 'c2', params: { doc: LANDING, instruction: 'x', mode: 'rewrite_selection' } }, { turnId: 't' }));
    expect(none.message).toContain('needs a selection anchor');
    const lost = refusalOf(
      harness.external.call(
        { name: 'scene.brief', callId: 'c3', params: { doc: LANDING, instruction: 'x', mode: 'rewrite_selection', selection: { from: 0, to: 6, exact: 'Zzzzzz', prefix: '', suffix: '', capturedRevision: 0 } } },
        { turnId: 't' },
      ),
    );
    expect(lost.message).toContain('could not be found');
  });

  it('refuses a document that is not there, and names nothing it was not asked', () => {
    const { harness } = hostOf(project());
    const error = refusalOf(harness.external.call({ name: 'scene.brief', callId: 'c4', params: { doc: 'Nowhere', instruction: 'x' } }, { turnId: 't' }));
    expect(error.code).toBe('not-found');
  });
});

describe('scene.apply', () => {
  const seed = () => {
    const state = project();
    return { state, ...hostOf(state) };
  };

  it('writes the host’s text through the in-app port as one undo group, and undo restores the prior body', () => {
    const { state, harness } = seed();
    const before = snapshotOf(state);
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    const done = valueOf(apply(harness, 'scene.apply', { ...given.applyWith, text: '  The tide turned.  ' }));
    expect(getBody(state, LANDING)).toBe('The ferry was late, as always.\n\nThe tide turned.');
    expect(done.summary).toBe('continued "The Landing" (3 words)');
    expect(done.undoGroupId).toBeDefined();
    expect(harness.undo.undo(done.undoGroupId ?? '').ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('drafts into an empty document, and rewrites a selected passage', () => {
    const { state, harness } = seed();
    const empty = briefOf(brief(harness, 'scene.brief', { doc: FRIEND, instruction: 'Introduce him.' }).data);
    valueOf(apply(harness, 'scene.apply', { ...empty.applyWith, text: 'Marek came in from the rain.' }));
    expect(getBody(state, FRIEND)).toBe('Marek came in from the rain.');
    const selection = { from: 4, to: 9, exact: 'ferry', prefix: 'The ', suffix: ' was', capturedRevision: getRevision(state, LANDING) };
    const rewrite = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'A boat.', mode: 'rewrite_selection', selection }).data);
    valueOf(apply(harness, 'scene.apply', { ...rewrite.applyWith, text: 'boat' }));
    expect(getBody(state, LANDING)).toBe('The boat was late, as always.');
  });

  it('refuses an unknown briefId, and an expired one, with the tool to ask again, and writes nothing', () => {
    let at = clock.now();
    const state = project();
    const { harness } = hostOf(state, undefined, createBriefLedger({ now: () => at }));
    const before = snapshotOf(state);
    const unknown = refusalOf(apply(harness, 'scene.apply', { doc: LANDING, text: 'x', mode: 'continue', briefId: 'b_0000000000' }));
    expect(unknown.message).toContain('is not one this server holds');
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    at += BRIEF_TTL_MS;
    const expired = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: 'x' }));
    expect(expired.message).toContain('expired after 30 minutes');
    expect(expired.correctiveHint).toContain('scene.brief');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a brief whose document changed, by the document’s title, and takes no revision from the caller', () => {
    const { state, harness } = seed();
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    valueOf(run(harness, 'notes.append', { doc: LANDING, text: 'unrelated' }));
    // A notes change is not the body: the brief still stands.
    expect(apply(harness, 'scene.apply', { ...given.applyWith, text: 'First.' }).ok).toBe(true);
    const stale = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: 'Second.' }));
    expect(stale.code).toBe('revision-conflict');
    expect(stale.message).toContain('"The Landing" has changed since the brief');
    expect(stale.message).not.toContain(LANDING);
    expect(getBody(state, LANDING)).not.toContain('Second.');
    const forged = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: 'Third.', expectedRevision: getRevision(state, LANDING) }));
    expect(forged.code).toBe('invalid-params');
  });

  it('refuses a briefId used for another document, another mode, another selection or the other kind', () => {
    const { harness } = seed();
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    expect(refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, doc: STORM, text: 'x' })).message).toContain('was made for "The Landing", and this call names "The Storm"');
    const empty = briefOf(brief(harness, 'scene.brief', { doc: FRIEND, instruction: 'Introduce him.' }).data);
    expect(refusalOf(apply(harness, 'scene.apply', { ...empty.applyWith, mode: 'continue', text: 'x' })).message).toContain('was made for mode draft');
    const other = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'x' }).data);
    expect(refusalOf(apply(harness, 'scene.apply', { doc: LANDING, mode: 'continue', text: 'x', briefId: other.briefId })).message).toContain('is a dialogue brief');
    const selection = { from: 4, to: 9, exact: 'ferry', prefix: 'The ', suffix: ' was', capturedRevision: 0 };
    const rewrite = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'A boat.', mode: 'rewrite_selection', selection }).data);
    const moved = { ...selection, from: 0, to: 3, exact: 'The', prefix: '', suffix: ' fe' };
    expect(refusalOf(apply(harness, 'scene.apply', { ...rewrite.applyWith, selection: moved, text: 'x' })).message).toContain('another selection');
  });

  it('refuses a reply over the in-app output limit, and an empty one, naming the limit, and writes nothing', () => {
    const { state, harness } = seed();
    const before = snapshotOf(state);
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    const long = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: 'a'.repeat(16_385) }));
    expect(long.code).toBe('limit-exceeded');
    expect(long.message).toContain('limit 16384');
    const blank = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: '   ' }));
    expect(blank.code).toBe('invalid-params');
    expect(snapshotOf(state)).toBe(before);
    expect(apply(harness, 'scene.apply', { ...given.applyWith, text: 'a'.repeat(16_384) }).ok).toBe(true);
  });

  it('refuses without the host’s confirmation, and for a caller on the external path', () => {
    const { state, harness } = seed();
    const before = snapshotOf(state);
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    const params = { ...given.applyWith, text: 'x' };
    expect(refusalOf(run(harness, 'scene.apply', params)).code).toBe('permission-denied');
    expect(refusalOf(harness.external.call({ name: 'scene.apply', callId: 'ext', params }, { turnId: 'ext' })).code).toBe('permission-denied');
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('dialogue.apply', () => {
  it('writes the host’s Ink through the in-app port, and undo restores the container', () => {
    const state = project();
    const { harness } = hostOf(state);
    const before = snapshotOf(state);
    const given = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'A thank-you.' }).data);
    expect(given.applyWith).toEqual({ doc: TAVERN, briefId: given.briefId });
    const done = valueOf(apply(harness, 'dialogue.apply', { ...given.applyWith, ink: `${INK}\n` }));
    expect(getBody(state, TAVERN)).toContain('Thanks for the drink.');
    expect(harness.undo.undo(done.undoGroupId ?? '').ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('places the Ink after the knot fromBeats names, and at the end of the body without it', () => {
    const body = ['=== first ===', 'Hello.', '-> second', '=== second ===', 'Bye.', '-> END', ''].join('\n');
    const make = (): ProjectState => {
      const state = makeState();
      addDocument(state, { id: TAVERN, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body, now: OPENED });
      return state;
    };
    const positions = (state: ProjectState) => {
      const text = getBody(state, TAVERN);
      return { first: text.indexOf('=== first ==='), reply: text.indexOf('=== reply ==='), second: text.indexOf('=== second ===') };
    };

    const named = make();
    const { harness } = hostOf(named);
    const given = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'x', fromBeats: ['first'] }).data);
    expect(given.applyWith).toEqual({ doc: TAVERN, fromBeats: ['first'], briefId: given.briefId });
    valueOf(apply(harness, 'dialogue.apply', { ...given.applyWith, ink: INK }));
    const after = positions(named);
    expect(after.reply).toBeGreaterThan(after.first);
    expect(after.reply).toBeLessThan(after.second);

    const bare = make();
    const other = hostOf(bare);
    const plain = briefOf(brief(other.harness, 'dialogue.brief', { doc: TAVERN, instruction: 'x' }).data);
    expect(plain.applyWith).toEqual({ doc: TAVERN, briefId: plain.briefId });
    valueOf(apply(other.harness, 'dialogue.apply', { ...plain.applyWith, ink: INK }));
    const appended = positions(bare);
    expect(appended.reply).toBeGreaterThan(appended.second);
  });

  it('refuses Ink that does not compile with the dialogue module’s own words, and writes nothing', () => {
    const state = project();
    const { harness } = hostOf(state);
    const before = snapshotOf(state);
    const given = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'x' }).data);
    const error = refusalOf(apply(harness, 'dialogue.apply', { ...given.applyWith, ink: ['=== reply ===', '* [Unclosed choice', '-> END'].join('\n') }));
    expect(error.message).toMatch(/compile/i);
    expect(snapshotOf(state)).toBe(before);
    // The brief still stands for a second try.
    expect(apply(harness, 'dialogue.apply', { ...given.applyWith, ink: INK }).ok).toBe(true);
  });

  it('refuses a stale brief when the container changed, naming it by title', () => {
    const state = project();
    const { harness } = hostOf(state);
    const given = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'x' }).data);
    const second = briefOf(brief(harness, 'dialogue.brief', { doc: TAVERN, instruction: 'y' }).data);
    valueOf(apply(harness, 'dialogue.apply', { ...second.applyWith, ink: INK }));
    const stale = refusalOf(apply(harness, 'dialogue.apply', { ...given.applyWith, ink: OTHER_INK }));
    expect(stale.code).toBe('revision-conflict');
    expect(stale.message).toContain('"Tavern" has changed since the brief');
  });
});

describe('the rules of the project hold for a brief and an apply as they hold for the in-app tool', () => {
  const secret = (state: ProjectState): string => {
    addDocument(state, { id: 'n_SECRET0001', parentId: CHAPTER_HIDDEN, title: 'The Secret', body: 'The ledger is under the third stone.', synopsis: 'A hidden ledger.', now: OPENED });
    return 'n_SECRET0001';
  };
  const CHAPTER_HIDDEN = 'n_CHAPTR0002';

  it('keeps what a read-deny on scene.draft withholds out of the brief’s messages', () => {
    const state = project();
    secret(state);
    const { harness } = hostOf(state, () => ({ rules: [{ effect: 'deny', tool: 'scene.draft', scope: { subtree: CHAPTER_HIDDEN }, access: 'read', source: 'project' }] }));
    const data = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue', include_forward_outline: true }).data);
    const text = JSON.stringify(data);
    expect(text).not.toContain('third stone');
    expect(text).not.toContain('The Secret');
    // The drop list says how many items the rule kept out, and never which: the count is the layer's note, the names are gone.
    const dropped = data.droppedContext.join('\n');
    expect(dropped).toMatch(/\d+ items? (is|are) withheld by a read rule/);
    expect(dropped).not.toContain('n_SECRET0001');
    expect(dropped).not.toContain('Secret');
  });

  it('keeps it out of a rule written for the brief by name, and out of a dialogue brief', () => {
    const state = project();
    secret(state);
    const rules: RulesProvider = () => ({ rules: [{ effect: 'deny', tool: 'scene.brief', scope: { subtree: CHAPTER_HIDDEN }, access: 'read', source: 'project' }] });
    const { harness } = hostOf(state, rules);
    expect(JSON.stringify(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue', include_forward_outline: true }).data)).not.toContain('third stone');
  });

  it('does not name a withheld document when the title of an apply is ambiguous, in the check the server runs before it asks', () => {
    const state = project();
    secret(state);
    addDocument(state, { id: 'n_TW1N000001', parentId: 'n_CHAPTR0001', title: 'Twin', body: 'a', now: OPENED });
    addDocument(state, { id: 'n_TW1N000002', parentId: CHAPTER_HIDDEN, title: 'Twin', body: 'b', now: OPENED });
    const ledger = createBriefLedger({ now: () => clock.now() });
    const { harness } = hostOf(state, () => ({ rules: [{ effect: 'deny', tool: 'scene.draft', scope: { subtree: CHAPTER_HIDDEN }, access: 'read', source: 'project' }] }), ledger);
    const given = briefOf(brief(harness, 'scene.brief', { doc: 'n_TW1N000001', instruction: 'x', mode: 'continue' }).data);
    const params = { doc: 'Twin', text: 'x', mode: 'continue', briefId: given.briefId };
    const hidden = harness.withheld('scene.apply');
    expect(hidden.has('n_TW1N000002')).toBe(true);
    const refused = briefRefusal(ledger, 'scene.apply', params, state, hidden);
    expect(JSON.stringify(refused)).not.toContain('n_TW1N000002');
    expect(JSON.stringify(briefRefusal(ledger, 'scene.apply', params, state))).toContain('n_TW1N000002');
  });

  it('does not name a withheld document that an apply reaches by a unique title prefix, nor a focus that has become withheld', () => {
    const state = project();
    secret(state);
    const ledger = createBriefLedger({ now: () => clock.now() });
    const { harness } = hostOf(state, () => ({ rules: [{ effect: 'deny', tool: 'scene.draft', scope: { subtree: CHAPTER_HIDDEN }, access: 'read', source: 'project' }] }), ledger);
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'x', mode: 'continue' }).data);
    const hidden = harness.withheld('scene.apply');
    const params = { doc: 'The Secret', text: 'x', mode: 'continue', briefId: given.briefId };
    // The server's check leaves it to the gate; the held check, if reached, refuses without a title.
    expect(briefRefusal(ledger, 'scene.apply', params, state, hidden)).toBeUndefined();
    const held = heldBrief(ledger, 'scene.apply', params, state, hidden);
    expect(held.ok).toBe(false);
    expect(JSON.stringify(held)).not.toContain('Secret');
    // A brief made for a document a rule later withholds does not name it when the apply names another.
    const toSecret = ledger.mint({ kind: 'scene', focus: 'n_SECRET0001', revision: 1, digest: 'd', mode: 'continue' });
    const elsewhere = briefRefusal(ledger, 'scene.apply', { doc: LANDING, text: 'x', mode: 'continue', briefId: toSecret.id }, state, hidden);
    expect(elsewhere?.code).toBe('invalid-params');
    expect(JSON.stringify(elsewhere)).not.toContain('Secret');
  });

  it('refuses a brief and an apply aimed at a withheld or locked document, as the in-app tool is refused', () => {
    const state = project();
    const id = secret(state);
    const { harness } = hostOf(state, () => ({
      rules: [
        { effect: 'deny', tool: 'scene.draft', scope: { subtree: CHAPTER_HIDDEN }, access: 'read', source: 'project' },
        { effect: 'deny', tool: 'scene.draft', scope: { subtree: 'n_CHAPTR0001' }, access: 'write', source: 'project', note: 'Locked' },
      ],
    }));
    const hidden = refusalOf(harness.external.call({ name: 'scene.brief', callId: 'h1', params: { doc: id, instruction: 'x', mode: 'continue' } }, { turnId: 't' }));
    expect(hidden.code).toBe('permission-denied');
    expect(JSON.stringify(hidden)).not.toContain('third stone');
    // A write-lock leaves the brief (a read) alone, and refuses the apply.
    const given = briefOf(brief(harness, 'scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' }).data);
    const locked = refusalOf(apply(harness, 'scene.apply', { ...given.applyWith, text: 'x' }));
    expect(locked.code).toBe('permission-denied');
    expect(locked.message).toContain('Locked');
    expect(getBody(state, LANDING)).toBe('The ferry was late, as always.');
  });
});
