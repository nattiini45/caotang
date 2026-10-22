/**
 * `shots.derive` — storyboard.md §4 tool 18. Planning checks the proposal, captures anchors against the
 * scene as it is, mints the ids and writes the commands that create the folder and the cards. The commands
 * apply once the scene has not moved, and the ids they create are the ids the plan named.
 */

import { moveNode, removeNode, setBody } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  applyStoryboardCommands,
  displayNumberOf,
  planDerive,
  shotTitleOf,
  shotsIn,
  storyboardFolders,
  type DerivePlan,
  type ShotCommand,
} from '../src/index.js';

import { NOW, SCENE_BODY, buildFixture, treeSnapshot, type Fixture } from './fixtures.js';

const GOOD = {
  shots: [
    {
      shotSize: 'WS',
      cameraAngle: 'eye',
      cameraMovement: 'static',
      action: 'Elena crosses the empty quay.',
      durationSec: 4,
      dialogueQuotes: ['Elena crosses the empty quay. Gulls circle.'],
    },
    {
      shotSize: 'CU',
      action: 'ELENA speaks.',
      dialogueQuotes: ['I was gone nine years.', 'Nobody said this'],
    },
    {
      shotSize: 'MS',
      transition: 'cut',
      action: 'The keeper does not look up.',
      dialogueQuotes: ['The lighthouse keeper does not look up.'],
    },
  ],
};

function planOf(fixture: Fixture, proposal: unknown = GOOD, overrides: { docId?: string; granularity?: 'key-shots' | 'full-coverage'; styleNote?: string } = {}): DerivePlan {
  const result = planDerive(fixture.state, { docId: overrides.docId ?? 'scene1', ...overrides }, proposal);
  if (!result.ok) throw new Error(`plan refused: ${result.refusal.code} ${result.refusal.message}`);
  return result.value;
}

function refusalOf(fixture: Fixture, proposal: unknown, docId = 'scene1') {
  const result = planDerive(fixture.state, { docId }, proposal);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

describe('planning: the proposal is checked before anything else', () => {
  it('refuses a document id that names no document', () => {
    expect(refusalOf(buildFixture(), GOOD, 'nope')).toMatchObject({ code: 'doc-missing' });
  });

  it('refuses a prose document, in the spec’s words', () => {
    const refusal = refusalOf(buildFixture(), GOOD, 'prose1');
    expect(refusal.code).toBe('not-screenplay');
    expect(refusal.message.startsWith('derive works on screenplay scenes — this doc is prose')).toBe(true);
  });

  it('asks the writer, not the model, when the scene is empty', () => {
    expect(refusalOf(buildFixture(), GOOD, 'empty1')).toMatchObject({ code: 'doc-empty', askBack: 'needs_input' });
  });

  it('refuses a proposal that is not an object with a list of shots', () => {
    expect(refusalOf(buildFixture(), undefined)).toMatchObject({ code: 'proposal-malformed' });
    expect(refusalOf(buildFixture(), { shots: 'three' })).toMatchObject({ code: 'proposal-malformed' });
  });

  it('asks the writer when the model proposes no shots at all', () => {
    expect(refusalOf(buildFixture(), { shots: [] })).toMatchObject({ code: 'proposal-empty', askBack: 'needs_input' });
  });

  it('refuses more than 60 shots and says to split the scene', () => {
    const refusal = refusalOf(buildFixture(), { shots: Array.from({ length: 61 }, () => ({ action: 'x' })) });
    expect(refusal.code).toBe('too-many-shots');
    expect(refusal.message).toContain('Split the scene');
  });

  it('refuses a value outside a closed list, names the shot, and lists the valid values', () => {
    const refusal = refusalOf(buildFixture(), { shots: [{ shotSize: 'WS' }, { shotSize: 'XXL' }] });
    expect(refusal.code).toBe('enum-invalid');
    expect(refusal.message.startsWith('shot 2:')).toBe(true);
    expect(refusal.message).toContain('WS, FS, MFS');
  });

  it('refuses a field the shot schema does not have, rather than dropping it', () => {
    const refusal = refusalOf(buildFixture(), { shots: [{ action: 'a', colour: 'red' }] });
    expect(refusal.code).toBe('proposal-unknown-field');
    expect(refusal.message).toContain('"colour"');
  });

  it('refuses an action over 1000 code points, and a negative duration', () => {
    expect(refusalOf(buildFixture(), { shots: [{ action: 'a'.repeat(1001) }] }).code).toBe('action-too-long');
    expect(refusalOf(buildFixture(), { shots: [{ durationSec: -2 }] }).code).toBe('duration-invalid');
  });

  it('refuses a quote that is not text, is empty, or is over the anchor bound', () => {
    expect(refusalOf(buildFixture(), { shots: [{ dialogueQuotes: 'ELENA' }] }).code).toBe('proposal-malformed');
    expect(refusalOf(buildFixture(), { shots: [{ dialogueQuotes: [''] }] }).code).toBe('proposal-malformed');
    expect(refusalOf(buildFixture(), { shots: [{ dialogueQuotes: ['x'.repeat(2001)] }] }).code).toBe('quote-too-long');
  });

  it('refuses a plan that makes no change to the state', () => {
    const fixture = buildFixture();
    const before = treeSnapshot(fixture.state);
    planOf(fixture);
    refusalOf(fixture, { shots: [] });
    expect(treeSnapshot(fixture.state)).toBe(before);
  });
});

describe('planning: each dialogue quote becomes an anchor against the scene, or a note', () => {
  it('captures an anchor whose offsets hold exactly the quoted text, with its context', () => {
    const plan = planOf(buildFixture());
    const first = plan.shots[0]?.stored.dialogue as Array<{ anchor: { from: number; to: number; exact: string; prefix: string; suffix: string; capturedRevision: number } }>;
    const anchor = first[0]?.anchor;
    expect(anchor).toBeDefined();
    expect(SCENE_BODY.slice(anchor?.from, anchor?.to)).toBe('Elena crosses the empty quay. Gulls circle.');
    expect(anchor?.exact).toBe('Elena crosses the empty quay. Gulls circle.');
    expect(anchor?.prefix).toBe('EXT. HARBOUR - DAWN\n\n');
    expect(anchor?.suffix).toBe('\n\nELENA\nI was gone nine years.\n\n');
    expect(anchor?.capturedRevision).toBe(0);
  });

  it('keeps no coverage for a quote that appears twice, and says why', () => {
    const plan = planOf(buildFixture());
    const second = plan.shots[1];
    expect(second?.stored.dialogue).toBeUndefined();
    expect(second?.unanchored).toEqual([
      { quote: 'I was gone nine years.', reason: 'ambiguous', count: 2 },
      { quote: 'Nobody said this', reason: 'not-found' },
    ]);
    expect(plan.notes.join('\n')).toContain('appears 2 times in the scene');
    expect(plan.notes.join('\n')).toContain('is not in the scene verbatim');
  });

  it('keeps the other shots’ coverage when one quote fails, so a shot is never wholly lost', () => {
    const plan = planOf(buildFixture());
    expect(plan.shots).toHaveLength(3);
    expect(plan.shots[2]?.stored.dialogue).toBeDefined();
  });

  it('records the granularity and the style note on the plan, and defaults the granularity', () => {
    const plan = planOf(buildFixture(), GOOD, { styleNote: 'handheld and tight' });
    expect(plan).toMatchObject({ granularity: 'key-shots', styleNote: 'handheld and tight' });
    expect(planOf(buildFixture(), GOOD, { granularity: 'full-coverage' }).granularity).toBe('full-coverage');
  });

  it('writes a tree diff the plan card can show: the folder, then one line per shot with its spec row', () => {
    const plan = planOf(buildFixture());
    expect(plan.treeDiff[0]).toBe('+ folder "Harbour — Shots" (storyboard) under "Act 1"');
    expect(plan.treeDiff[1]).toBe('  + shot 1 "Elena crosses the empty quay." · Wide shot (WS) · Eye level · Static · 4 s');
    expect(plan.treeDiff[2]).toBe('  + shot 2 "ELENA speaks." · Close-up (CU)');
  });

  it('words the tree diff but keeps the tokens in each shot’s stored fields', () => {
    const plan = planOf(buildFixture());
    expect(plan.shots[0]?.stored).toMatchObject({ shotSize: 'WS', cameraAngle: 'eye', cameraMovement: 'static' });
    expect(plan.treeDiff.join(' | ')).not.toContain('static ·');
  });

  it('names a shot from the first line of its action, cut to 40 code points', () => {
    expect(shotTitleOf('Elena crosses the empty quay.')).toBe('Elena crosses the empty quay.');
    expect(shotTitleOf('')).toBe('Shot');
    expect(shotTitleOf('\n   \nFirst real line\nsecond')).toBe('First real line');
    const long = shotTitleOf('a'.repeat(60));
    expect([...long]).toHaveLength(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

/** Applies a plan's commands, the way the bus does once the writer approves the card. */
function applyPlan(fixture: Fixture, plan: DerivePlan) {
  return applyStoryboardCommands(fixture.state, plan.commands, { now: NOW });
}

describe('the commands: the folder first, then one card per shot, every id minted by the plan', () => {
  it('names the folder as the first command, and each card as a shot.create under that folder', () => {
    const plan = planOf(buildFixture());
    expect(plan.commands.map((command) => command.name)).toEqual(['storyboard.create', 'shot.create', 'shot.create', 'shot.create']);
    const [folder, ...cards] = plan.commands;
    expect(folder).toEqual({
      name: 'storyboard.create',
      params: {
        id: plan.folderId,
        parentId: 'act1',
        title: 'Harbour — Shots',
        scene: { id: 'scene1', parentId: 'act1', revision: 0 },
      },
    });
    for (const [index, card] of cards.entries()) {
      expect(card).toMatchObject({ name: 'shot.create', params: { id: plan.shotIds[index], parentId: plan.folderId } });
    }
  });

  it('mints ids that are new to the tree, and distinct from each other, so no command can collide', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    const existing = new Set(fixture.state.manifest.tree.map((node) => node.id));
    const minted = [plan.folderId, ...plan.shotIds];
    expect(new Set(minted).size).toBe(minted.length);
    for (const id of minted) expect(existing.has(id)).toBe(false);
  });

  it('writes no node: the plan is data until the bus applies its commands', () => {
    const fixture = buildFixture();
    const before = treeSnapshot(fixture.state);
    planOf(fixture);
    expect(treeSnapshot(fixture.state)).toBe(before);
  });
});

describe('applying the commands: the folder and the cards, once the scene has not moved', () => {
  it('creates a storyboard folder named for the scene, beside it, and the cards in proposal order', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    expect(applyPlan(fixture, plan).ok).toBe(true);

    const folder = fixture.state.manifest.tree.find((node) => node.id === plan.folderId);
    expect(folder).toMatchObject({ title: 'Harbour — Shots', type: 'folder', parentId: 'act1', kind: 'storyboard' });
    expect(folder?.order).toBeGreaterThan(fixture.state.manifest.tree.find((node) => node.id === 'scene1')?.order ?? 0);
    expect(storyboardFolders(fixture.state).map((node) => node.id)).toContain(plan.folderId);

    expect(shotsIn(fixture.state, plan.folderId).map((node) => node.title)).toEqual([
      'Elena crosses the empty quay.',
      'ELENA speaks.',
      'The keeper does not look up.',
    ]);
    expect(displayNumberOf(fixture.state, plan.shotIds[2] ?? '')).toBe(3);
  });

  it('stores each shot with the metadata the plan carried, and does not share an object with the plan', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    expect(applyPlan(fixture, plan).ok).toBe(true);
    const cardId = plan.shotIds[0] ?? '';
    const card = fixture.state.manifest.tree.find((node) => node.id === cardId) as { shot?: { shotSize?: string } } | undefined;
    expect(card?.shot).toEqual(plan.shots[0]?.stored);
    expect(card?.shot).not.toBe(plan.shots[0]?.stored);
    (plan.shots[0]?.stored as { shotSize?: string }).shotSize = 'ECU';
    expect(card?.shot?.shotSize).toBe('WS');
  });

  it('refuses when the scene has changed since the plan, with nothing created and a conflict to ask about', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    setBody(fixture.state, 'scene1', `${SCENE_BODY}\n\nA new line.`);
    const before = treeSnapshot(fixture.state);
    const applied = applyPlan(fixture, plan);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.refusal).toMatchObject({ code: 'revision-drift', askBack: 'conflict' });
      expect(applied.refusal.message).toContain('Derive again');
    }
    expect(treeSnapshot(fixture.state)).toBe(before);
  });

  it('refuses when the scene was moved to another folder after the plan, since a move leaves the revision alone', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    moveNode(fixture.state, 'scene1', { parentId: 'manuscript' });
    const before = treeSnapshot(fixture.state);
    expect(applyPlan(fixture, plan)).toMatchObject({ ok: false, refusal: { code: 'scene-moved', askBack: 'conflict' } });
    expect(treeSnapshot(fixture.state)).toBe(before);
  });

  it('refuses when the scene is no longer in the binder, with nothing created', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    removeNode(fixture.state, 'scene1');
    expect(applyPlan(fixture, plan)).toMatchObject({ ok: false, refusal: { code: 'scene-changed', askBack: 'conflict' } });
    expect(storyboardFolders(fixture.state).map((node) => node.title)).toEqual(['Board']);
  });

  it('refuses a list in which one card cannot land, and writes nothing, not even the folder before it', () => {
    const fixture = buildFixture();
    const plan = planOf(fixture);
    const before = treeSnapshot(fixture.state);
    // A card whose id is already taken is refused by the second command, after the first would have run.
    const clash: ShotCommand[] = [
      ...plan.commands.slice(0, 1),
      { name: 'shot.create', params: { id: 'board1', parentId: plan.folderId, title: 'x', stored: {} } },
      ...plan.commands.slice(2),
    ];
    expect(applyStoryboardCommands(fixture.state, clash, { now: NOW })).toMatchObject({
      ok: false,
      refusal: { code: 'id-taken' },
    });
    expect(treeSnapshot(fixture.state)).toBe(before);
  });

  it('the ids the plan named are the ids the commands create, so removing that folder reverses the whole group', () => {
    const fixture = buildFixture();
    const before = treeSnapshot(fixture.state);
    const plan = planOf(fixture);
    expect(applyPlan(fixture, plan).ok).toBe(true);
    expect(treeSnapshot(fixture.state)).not.toBe(before);
    removeNode(fixture.state, plan.folderId);
    expect(treeSnapshot(fixture.state)).toBe(before);
  });
});

describe('the plan is a value, and planning is pure', () => {
  it('leaves the state untouched by a successful plan', () => {
    const fixture = buildFixture();
    const before = treeSnapshot(fixture.state);
    planOf(fixture);
    expect(treeSnapshot(fixture.state)).toBe(before);
  });
});
