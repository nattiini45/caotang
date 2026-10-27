import { expect, test } from '@playwright/test';

import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { elapsedOf, formatElapsed } from '../../apps/desktop/src/app/agent-model.js';
import { costLineOf, formatUsd, NEW_ENTRY_FROM, planCostOf, refusalReasonOf, stepPreviewOf, turnCostOf, wordDiff } from '../../apps/desktop/src/app/plan-preview.js';
import { withoutIsolates } from '../support.js';

/**
 * The view model of what a plan card draws for a step's preview (agent-harness §3 rows 7, 9 and 13), the prices it shows, and the
 * elapsed time of a call. These are pure model tests: each value checks the view the card is built from, against the preview the
 * harness puts on the step. What reaches the DOM before approval is checked in the browser, in e2e/agent-plan-preview.spec.ts.
 */

const state = sampleProjectState();
const [first] = state.manifest.tree;
if (first === undefined) throw new Error('the sample project has no node to name');

test.describe('the view model of a synopsis batch carries each row’s document, action, text and words', () => {
  test('each row names its document, says whether it is new or replaces one, and carries its text and words', () => {
    const view = stepPreviewOf(
      'synopsis.fill',
      {
        rows: [
          { doc: 'The Friend', action: 'create', synopsis: 'A keeper meets a stranger.', words: 5 },
          { doc: 'The Storm', action: 'replace', synopsis: 'The lamp fails.', words: 3 },
        ],
      },
      state,
    );
    expect(view).toEqual({
      kind: 'synopses',
      rows: [
        { doc: 'The Friend', action: 'create', synopsis: 'A keeper meets a stranger.', words: 5 },
        { doc: 'The Storm', action: 'replace', synopsis: 'The lamp fails.', words: 3 },
      ],
    });
  });
});

test.describe('the view model of a notes rewrite is the old notes and the new, word by word', () => {
  test('keeps the words both share, marks the words taken out and the words added, and counts both texts', () => {
    const view = stepPreviewOf(
      'notes.replace',
      { doc: 'The Landing', before: 'Fix pacing in the last three paragraphs.', after: 'Fix the pacing in the final paragraphs.' },
      state,
    );
    expect(view).toEqual({
      kind: 'notes',
      doc: 'The Landing',
      segments: [
        { kind: 'same', text: 'Fix ' },
        { kind: 'added', text: 'the ' },
        { kind: 'same', text: 'pacing in the ' },
        { kind: 'removed', text: 'last three' },
        { kind: 'added', text: 'final' },
        { kind: 'same', text: ' paragraphs.' },
      ],
      wordsBefore: 7,
      wordsAfter: 7,
    });
  });

  test('joins back to the new text without the removed runs, and to the old text without the added ones', () => {
    const before = 'One two three\n\nfour five six.';
    const after = 'One three\n\nfour 5 six seven.';
    const segments = wordDiff(before, after);
    expect(segments.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(after);
    expect(segments.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(before);
  });

  test('shows a clear as all removed, a first write as all added, and equal texts as one kept run', () => {
    expect(wordDiff('old notes', '')).toEqual([{ kind: 'removed', text: 'old notes' }]);
    expect(wordDiff('', 'new notes')).toEqual([{ kind: 'added', text: 'new notes' }]);
    expect(wordDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  test('falls back to the old words out and the new words in when the middle is too large to match', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `a${index}`).join(' ');
    const after = Array.from({ length: 2500 }, (_, index) => `b${index}`).join(' ');
    expect(wordDiff(before, after)).toEqual([
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ]);
  });

  test('is not drawn for a preview that is not a notes rewrite', () => {
    expect(stepPreviewOf('notes.replace', { doc: 'x' }, state)).toBeUndefined();
  });
});

test.describe('the view model of a codex write carries its entries, their changes and their attachments by title', () => {
  test('an attachment names its document, and an id the project no longer holds is named in words', () => {
    const view = stepPreviewOf(
      'codex.write',
      {
        entries: [
          {
            action: 'create',
            name: 'Kestrel',
            attach: [first.id, 'n_NOTHERE0001'],
            flags: ['always-include affects every generation call'],
          },
          {
            action: 'update',
            id: 'c_KSTR000001',
            name: 'Elena',
            changes: [{ field: 'description', from: '"The keeper."', to: '"The keeper of the light."' }],
            detach: [first.id],
          },
        ],
      },
      state,
    );
    expect(view).toEqual({
      kind: 'codex',
      entries: [
        {
          name: 'Kestrel',
          action: 'create',
          // A create always lists its picture references, so one with none says “(none)”: the only change a bare create shows.
          changes: [{ field: 'Visual references', from: NEW_ENTRY_FROM, to: '(none)' }],
          attached: [first.title, 'a document that is no longer in the project'],
          detached: [],
          flags: ['Always included: this entry goes into every drafting call'],
        },
        {
          name: 'Elena',
          action: 'update',
          // The field is named in the writer's words, and each value is read back from its JSON text, so no quotes show.
          changes: [{ field: 'Description', from: 'The keeper.', to: 'The keeper of the light.' }],
          attached: [],
          detached: [first.title],
          flags: [],
        },
      ],
    });
  });

  test('a new entry carries each field it holds, from “(new entry)”, in the writer’s words, so its description is in the preview', () => {
    const view = stepPreviewOf(
      'codex.write',
      {
        entries: [
          {
            action: 'create',
            name: 'Kestrel',
            type: 'character',
            description: 'The bird that circles the lighthouse at dusk.',
            aliases: ['the bird', 'the hunter'],
            includePolicy: 'manual',
            caseSensitive: false,
          },
        ],
      },
      state,
    );
    expect(view).toEqual({
      kind: 'codex',
      entries: [
        {
          name: 'Kestrel',
          action: 'create',
          changes: [
            { field: 'Type', from: NEW_ENTRY_FROM, to: 'character' },
            { field: 'Description', from: NEW_ENTRY_FROM, to: 'The bird that circles the lighthouse at dusk.' },
            { field: 'Also known as', from: NEW_ENTRY_FROM, to: 'the bird, the hunter' },
            { field: 'Included in drafting', from: NEW_ENTRY_FROM, to: 'Only when attached to the scene' },
            { field: 'Match case', from: NEW_ENTRY_FROM, to: 'No' },
            { field: 'Visual references', from: NEW_ENTRY_FROM, to: '(none)' },
          ],
          attached: [],
          detached: [],
          flags: [],
        },
      ],
    });
  });

  test('a create and an update name their pictures by file name, in the writer’s words, and a missing picture is named as missing', () => {
    // The pictures come from the project's own asset store, by id: the card shows their file names, never the ids.
    const names = new Map([['a_8K3QZ2M7RD', 'storm-cover.png']]);
    const created = stepPreviewOf(
      'codex.write',
      { entries: [{ action: 'create', name: 'Kestrel', visualRefs: ['a_8K3QZ2M7RD', 'a_GONE000000'] }] },
      state,
      names,
    );
    expect(created).toEqual({
      kind: 'codex',
      entries: [
        {
          name: 'Kestrel',
          action: 'create',
          changes: [{ field: 'Visual references', from: NEW_ENTRY_FROM, to: 'storm-cover.png, a picture that is no longer in the project' }],
          attached: [],
          detached: [],
          flags: [],
        },
      ],
    });

    const updated = stepPreviewOf(
      'codex.write',
      {
        entries: [
          {
            action: 'update',
            id: 'c_KSTR000001',
            name: 'Elena',
            changes: [{ field: 'visualRefs', from: 'null', to: '["a_8K3QZ2M7RD"]' }],
          },
        ],
      },
      state,
      names,
    );
    expect(updated).toMatchObject({ kind: 'codex', entries: [{ changes: [{ field: 'Visual references', from: '(none)', to: 'storm-cover.png' }] }] });
    // Neither the internal field name nor a raw id reaches the card.
    expect(JSON.stringify(updated)).not.toMatch(/visualRefs|a_8K3QZ2M7RD/);

    const cleared = stepPreviewOf(
      'codex.write',
      { entries: [{ action: 'update', id: 'c_KSTR000001', name: 'Elena', changes: [{ field: 'visualRefs', from: '["a_8K3QZ2M7RD"]', to: '[]' }] }] },
      state,
      names,
    );
    expect(cleared).toMatchObject({ kind: 'codex', entries: [{ changes: [{ field: 'Visual references', from: 'storm-cover.png', to: '(none)' }] }] });
  });

  test('an update that clears a list or a policy names “(none)” and the policy in words, never the internal value', () => {
    const view = stepPreviewOf(
      'codex.write',
      {
        entries: [
          {
            action: 'update',
            id: 'c_KSTR000001',
            name: 'Elena',
            changes: [
              { field: 'aliases', from: '["Hanne"]', to: '[]' },
              { field: 'includePolicy', from: '"detected"', to: '"never"' },
            ],
          },
        ],
      },
      state,
    );
    expect(view).toMatchObject({
      kind: 'codex',
      entries: [
        {
          changes: [
            { field: 'Also known as', from: 'Hanne', to: '(none)' },
            { field: 'Included in drafting', from: 'When its name or an alias appears in the text', to: 'Never' },
          ],
        },
      ],
    });
  });
});

test.describe('the view model of a restructure carries where each item sits now and where it lands', () => {
  test('a moved item shows its old place and its new one, and a created item shows that it is new', () => {
    const view = stepPreviewOf(
      'binder.restructure',
      {
        lines: ['move "Scene" to Chapter 2'],
        tree: [
          {
            id: 'n_SCENE00001',
            change: 'moved',
            before: { parentId: 'n_CHAP000001', parentTitle: 'Chapter 1', title: 'Scene' },
            after: { parentId: 'n_CHAP000002', parentTitle: 'Chapter 2', title: 'Scene' },
          },
          { id: null, change: 'created', type: 'document', after: { parentId: null, parentTitle: null, title: 'New' } },
        ],
      },
      state,
    );
    if (view === undefined || view.kind !== 'tree') throw new Error('expected a tree preview');
    expect(view.lines).toEqual(['move "Scene" to Chapter 2']);
    expect(view.rows.map((row) => ({ ...row, from: withoutIsolates(row.from), to: withoutIsolates(row.to) }))).toEqual([
      { title: 'Scene', change: 'Moved', from: 'Scene, in Chapter 1', to: 'Scene, in Chapter 2' },
      { title: 'New', change: 'Created', from: 'Not in the project yet', to: 'New' },
    ]);
  });
});

test.describe('the view model of a derive carries its shot list, the folder it creates and the tree diff (storyboard.md §4)', () => {
  test('each shot names its number, title and spec row, and the tree diff lines and notes are carried as written', () => {
    const view = stepPreviewOf(
      'shots.derive',
      {
        folder: 'The Lamp Scene — Shots',
        shots: [
          { number: 1, title: 'The lamp fails.', spec: 'WS · 4 s' },
          { number: 2, title: 'The keeper climbs the stair.', spec: '' },
        ],
        lines: ['+ folder "The Lamp Scene — Shots" (storyboard) under "Chapter 1"', '  + shot 1 "The lamp fails." · WS · 4 s', '  + shot 2 "The keeper climbs the stair."'],
        notes: ['shot 1: the quote "Nobody said this" is not in the scene verbatim, so no coverage was kept for it'],
      },
      state,
    );
    expect(view).toEqual({
      kind: 'shots',
      folder: 'The Lamp Scene — Shots',
      shots: [
        { number: 1, title: 'The lamp fails.', spec: 'WS · 4 s' },
        { number: 2, title: 'The keeper climbs the stair.', spec: '' },
      ],
      lines: ['+ folder "The Lamp Scene — Shots" (storyboard) under "Chapter 1"', '  + shot 1 "The lamp fails." · WS · 4 s', '  + shot 2 "The keeper climbs the stair."'],
      notes: ['shot 1: the quote "Nobody said this" is not in the scene verbatim, so no coverage was kept for it'],
    });
  });

  test('a derive preview with no folder is not drawn, so the card shows the step’s params as it always has', () => {
    expect(stepPreviewOf('shots.derive', { shots: [] }, state)).toBeUndefined();
  });
});

test.describe('the reason a refused step gives is shown beside a disabled Approve (agent-harness §2)', () => {
  test('is the first refused step’s own message in the preflight’s words, and none when no step was refused', () => {
    expect(
      refusalReasonOf([{ status: 'ready' }, { status: 'refused', error: { message: 'the passage is no longer in the scene' } }]),
    ).toBe('The passage is no longer in the scene');
    expect(refusalReasonOf([{ status: 'ready' }, { status: 'deferred' }])).toBeUndefined();
    // A refusal with no message of its own gives the card nothing to show, so none is named.
    expect(refusalReasonOf([{ status: 'refused' }])).toBeUndefined();
  });

  test('is the message and its corrective hint as two sentences, so the writer sees the choice the card offers', () => {
    expect(
      refusalReasonOf([
        {
          status: 'refused',
          error: {
            message: 'mode draft needs an empty document, and this one already has 2.1k words, so nothing was written',
            correctiveHint: 'set mode to continue to add to the end, or select a passage to rewrite it',
          },
        },
      ]),
    ).toBe(
      'Mode draft needs an empty document, and this one already has 2.1k words, so nothing was written. Set mode to continue to add to the end, or select a passage to rewrite it',
    );
  });
});

test.describe('a step the card does not draw has no preview view', () => {
  test('a tool with no preview shape, and a missing preview, give nothing to draw', () => {
    expect(stepPreviewOf('meta.set', { anything: true }, state)).toBeUndefined();
    expect(stepPreviewOf('synopsis.fill', undefined, state)).toBeUndefined();
    expect(stepPreviewOf('codex.write', 'not a record', state)).toBeUndefined();
  });
});

test.describe('the cost estimate is dollars, and absent when the profile has no price', () => {
  test('money reads with four decimals under a dollar, two above it, and a floor word for an amount too small to show', () => {
    expect(formatUsd(0.00001)).toBe('under $0.0001');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  test('a step with a price has its line, and an unpriced step has none', () => {
    expect(costLineOf(undefined)).toBeUndefined();
    expect(costLineOf({ promptUsd: 0.01, completionUsd: 0.02, totalUsd: 0.03 })).toBe('About $0.0300 (prompt $0.0100, reply $0.0200).');
  });

  test('a cost that counts thinking says so on its reply side', () => {
    expect(costLineOf({ promptUsd: 0.01, completionUsd: 0.02, totalUsd: 0.03, includesThinking: true })).toBe(
      'About $0.0300 (prompt $0.0100, reply $0.0200 including thinking).',
    );
  });

  test('the plan total adds the priced steps only, and is absent when no step is priced', () => {
    expect(planCostOf([0.01, undefined, 0.02])).toBeCloseTo(0.03, 10);
    expect(planCostOf([undefined, undefined])).toBeUndefined();
  });

  test('a turn’s cost prices its prompt and reply tokens per 1,000, and is absent on an unpriced profile', () => {
    expect(turnCostOf({ promptTokens: 1000, completionTokens: 500 }, { prompt: 0.01, completion: 0.03 })).toBeCloseTo(0.025, 10);
    expect(turnCostOf({ promptTokens: 1000, completionTokens: 500 }, null)).toBeUndefined();
  });
});

test.describe('a status card’s elapsed time', () => {
  test('reads in tenths of a second under a minute, and in minutes and seconds after', () => {
    expect(formatElapsed(1_500)).toBe('1.5 s');
    expect(formatElapsed(75_000)).toBe('1 min 15 s');
    expect(formatElapsed(-20)).toBe('0.0 s');
  });

  test('runs from its start to its finish, or to now while it still runs, and has none before it starts', () => {
    const base = { id: 'c', turnId: 't', callId: 'c', tool: 'meta.set', risk: 'write-auto', args: {} } as const;
    expect(elapsedOf({ ...base, status: 'running', startedAt: 1_000 }, 2_500)).toBe(1_500);
    expect(elapsedOf({ ...base, status: 'done', startedAt: 1_000, finishedAt: 2_000 }, 9_000)).toBe(1_000);
    expect(elapsedOf({ ...base, status: 'pending-approval' }, 9_000)).toBeUndefined();
  });
});
