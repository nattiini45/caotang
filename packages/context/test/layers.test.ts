/**
 * What each layer says, and where it says it (context-assembly §2). These tests read the
 * rendered messages, so they check the prompt the model gets, not an internal shape.
 */
import { describe, expect, it } from 'vitest';

import { ANTECEDENT_CHARS, assemble, type AgentTask, type ContextConfig } from '../src/index.js';
import { formatCount } from '../src/text.js';
import { CH1, CH2, CH3, FOCUS_ID, IDS, TAIL, buildApp, scopeApp, selectionOfFocus } from './fixtures.js';

const MARKER = '<<< current text ends here >>>';

function user(task: AgentTask, config: ContextConfig = {}): string {
  const assembled = assemble(task, buildApp(), config);
  return assembled.messages[1]?.content ?? '';
}

/** The focus section of a user message, from its heading to the recent turns. */
function focusOf(text: string): string {
  return text.slice(text.indexOf('# Focus'), text.indexOf('# Recent turns'));
}

function system(task: AgentTask, config: ContextConfig = {}): string {
  return assemble(task, buildApp(), config).messages[0]?.content ?? '';
}

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

describe('the message layout (§2)', () => {
  it('puts L0 alone in the system message, and L1 to L7 in one user message in fixed order', () => {
    const messages = assemble(CONTINUE, buildApp()).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content.startsWith('Caotang writing agent, system prompt v1.')).toBe(true);

    const text = messages[1]?.content ?? '';
    const headings = ['# Project', '# Codex', '# Structure', '# Story so far', '# Focus', '# Recent turns', '# Task'];
    const positions = headings.map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('keeps project content out of the system prompt (L0 carries none)', () => {
    const text = system(CONTINUE);
    expect(text).not.toContain('Harbor Notes');
    expect(text).not.toContain('Chapter');
    expect(text).not.toContain('Elena');
  });

  it('lists the tool surface one signature per line, and says so when there is none', () => {
    expect(system(CONTINUE)).toContain('- scene.draft(doc, instruction, mode?, target_words?, selection?)');
    const bare = assemble({ tool: 'meta', instruction: 'x' }, { state: buildApp().state });
    expect(bare.messages[0]?.content).toContain('- (no tools in this call)');
  });

  it('adds the JSON line only when a response format is an object (§5)', () => {
    expect(system(CONTINUE)).not.toContain('single JSON object');
    expect(system(CONTINUE, { responseFormat: 'text' })).not.toContain('single JSON object');
    expect(system(CONTINUE, { responseFormat: { jsonSchemaHint: { type: 'object' } } })).toContain(
      'Respond with a single JSON object and nothing else.',
    );
  });
});

describe('a layer the budget empties says its entries were not sent (§7)', () => {
  it('the structure, the story so far and the codex each say so, and not that nothing exists', () => {
    const text = user(CONTINUE, { layerBudgets: { L2: 0, L3: 0, L4: 0 } });
    expect(text).toContain('# Structure\n\n(structure not sent)');
    expect(text).toContain('# Story so far\n\n(story so far not sent)');
    expect(text).not.toContain('(no enclosing folders or earlier siblings)');
    expect(text).not.toContain('(no earlier scenes)');
  });

  it('the codex says so when the budget empties it, unless an always entry is reserved (A3)', () => {
    const app = buildApp();
    const harbor = (app.state.manifest.codex ?? []).find((item) => item.name === 'Harbor');
    if (harbor !== undefined) harbor.includePolicy = 'detected';
    const text = assemble(CONTINUE, app, { layerBudgets: { L2: 0 } }).messages[1]?.content ?? '';
    expect(text).toContain('# Codex\n\n(codex entries not sent)');
    // With the always entry in place, the same budget sends it whole.
    expect(user(CONTINUE, { layerBudgets: { L2: 0 } })).toContain('# Codex\n\n## Harbor (location)');
  });

  it('a layer with nothing to send still says there is nothing', () => {
    expect(user({ tool: 'scene.draft', instruction: 'x', mode: 'draft', focus: IDS.ch1 })).toContain('(no earlier scenes)');
  });
});

describe('L1, the project summary (§2)', () => {
  it('names the project, its documents and words, the session and the vocabulary', () => {
    const text = user({ tool: 'meta', instruction: 'Summarise the project.' });
    expect(text).toContain('Title: Harbor Notes');
    expect(text).toContain('Documents: 6. Words:');
    expect(text).toContain('Session: 412 words today, target 1,000.');
    expect(text).toContain('Statuses: draft (Draft), revised (Revised), final (Final).');
    expect(text).toContain('Labels: none.');
    expect(text).toContain('Saved filters: 0. Goals: 0.');
  });

  it('shows a two-level binder when it fits', () => {
    const text = user({ tool: 'meta', instruction: 'x' });
    expect(text).toContain('- Manuscript (folder)\n  - Act I (folder)\n  - Act II (folder)');
    expect(text).toContain('- Research (folder)\n  - Research notes (document)');
    expect(text).not.toContain('depth one');
  });

  it('falls back to depth one with document counts when the binder would overrun its budget', () => {
    const assembled = assemble({ tool: 'meta', instruction: 'x' }, buildApp(), { layerBudgets: { L1: 10 } });
    const text = assembled.messages[1]?.content ?? '';
    expect(text).toContain('Binder (depth one):');
    expect(text).toContain('- Manuscript (folder): 2 items, 5 documents');
    expect(text).toContain('- Research (folder): 1 item, 1 document');
    expect(assembled.layers[1]?.notes).toEqual(['The binder is shown at depth one. binder.read_tree shows any part in full.']);
  });

  it('says the session is unavailable when the app did not supply it', () => {
    const app = buildApp();
    const bare = { ...app, session: undefined };
    const text = assemble({ tool: 'meta', instruction: 'x' }, bare).messages[1]?.content ?? '';
    expect(text).toContain('Session: progress unavailable.');
  });
});

describe('L3, the structure (§2)', () => {
  it('lists the enclosing folders, then the earlier siblings, in reading order', () => {
    const text = user(CONTINUE);
    const structure = text.slice(text.indexOf('# Structure'), text.indexOf('# Story so far'));
    const order = ['## Manuscript (folder)', '## Act I (folder)', '## Chapter 1 (document)', '## Chapter 2 (document)'];
    const positions = order.map((heading) => structure.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('names a blank synopsis rather than skipping the document (§7)', () => {
    expect(user(CONTINUE)).toContain('## Chapter 2 (document)\n(no synopsis — Chapter 2)');
  });
});

describe('L4, the story so far (§2 and §4)', () => {
  it('sends only the synopses of documents before the focus, in manuscript order', () => {
    const text = user(CONTINUE);
    const story = text.slice(text.indexOf('# Story so far'), text.indexOf('# Focus'));
    expect(story).toContain('## Chapter 1 (document)\nElena reaches the harbor town');
    expect(story).toContain('## Chapter 2 (document)');
    expect(story).not.toContain('Chapter 3');
    expect(story).not.toContain('Chapter 4');
    expect(story).not.toContain(CH1.slice(0, 40)); // synopsis only, never the body
    expect(story.indexOf('Chapter 1')).toBeLessThan(story.indexOf('Chapter 2'));
  });

  it('withholds later scenes by default, and records how many', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const story = assembled.layers[4];
    expect(story?.dropped).toEqual([
      '2 later documents: forward outline withheld (includeForwardOutline is off)',
    ]);
    expect(story?.drops.map((drop) => drop.reason)).toEqual([{ kind: 'forward-outline' }]);
    expect(user(CONTINUE)).not.toContain('## Chapter 4');
  });

  it('includes the forward outline after the earlier scenes when the call asks for it', () => {
    const text = user({ ...CONTINUE, includeForwardOutline: true });
    const story = text.slice(text.indexOf('# Story so far'), text.indexOf('# Focus'));
    expect(story).toContain('## Chapter 4 (document)\nThe storm breaks over the breakwater.');
    expect(story).toContain('## Chapter 5 (document)');
    expect(story.indexOf('Chapter 2')).toBeLessThan(story.indexOf('Chapter 4'));
    const assembled = assemble({ ...CONTINUE, includeForwardOutline: true }, buildApp());
    expect(assembled.layers[4]?.kept.map((item) => item.reason)).toEqual([
      'earlier scene',
      'earlier scene',
      'later scene, sent because the call asks for the forward outline',
      'later scene, sent because the call asks for the forward outline',
    ]);
  });

  it('says why nothing precedes the focus when it is the first document', () => {
    const assembled = assemble({ ...CONTINUE, focus: IDS.ch1 }, buildApp());
    expect(assembled.layers[4]?.included).toBe(true);
    expect(assembled.layers[4]?.kept).toEqual([]);
    expect(user({ ...CONTINUE, focus: IDS.ch1 })).toContain('(no earlier scenes)');
  });
});

describe('L5, the focus text (§2)', () => {
  it('continue: the last 3,000 characters, labelled, and ended by the marker', () => {
    const text = user(CONTINUE);
    const focus = focusOf(text);
    expect(focus).toContain(`Document: Chapter 3 (continue; the last 3,000 of ${formatCount(CH3.length)} characters of the current text)`);
    expect(focus).toContain(TAIL);
    expect(focus).not.toContain(CH3.slice(0, 40));
    expect(focus.trimEnd().endsWith(MARKER)).toBe(true);
  });

  it('continue: the flow-up from the layers above leaves the tail at 3,000 characters unless the config opts in', () => {
    const held = focusOf(user(CONTINUE, { layerBudgets: { L3: 0, L4: 0 } }));
    expect(focusOf(user(CONTINUE))).toBe(held);
    expect(held).toContain(TAIL);
  });

  it('continue, with focusFlowUp: the whole chapter is sent when the flowed-in budget covers it', () => {
    const focus = focusOf(user(CONTINUE, { focusFlowUp: true }));
    expect(focus).toContain(`Document: Chapter 3 (continue; all ${formatCount(CH3.length)} characters of the current text)`);
    expect(focus).toContain(CH3);
  });

  it('draft: an empty document sends no body, and its synopsis and notes stand in', () => {
    const text = user({ tool: 'scene.draft', instruction: 'Draft the storm chapter.', mode: 'draft', focus: IDS.ch4 });
    const focus = text.slice(text.indexOf('# Focus'), text.indexOf('# Recent turns'));
    expect(focus).toContain('Document: Chapter 4 (draft; the document is empty, so its synopsis and notes stand in for the text)');
    expect(focus).toContain('Synopsis: The storm breaks over the breakwater.');
    expect(focus).toContain('Notes: (none)');
    expect(focus.trimEnd().endsWith(MARKER)).toBe(true);
  });

  it('rewrite_selection: the selection, with the 1,500 characters before it, each labelled', () => {
    const selection = selectionOfFocus();
    const text = user({
      tool: 'scene.draft',
      instruction: 'Rewrite this line more tersely.',
      mode: 'rewrite_selection',
      focus: FOCUS_ID,
      selection,
    });
    // The antecedent is the 1,500 characters before the selection, then the label, then the selection.
    const antecedent = CH3.slice(selection.from - ANTECEDENT_CHARS, selection.from);
    expect(text).toContain(`Preceding text:\n${antecedent}\n\nSelection to rewrite:\n${selection.exact}`);
    expect(text).not.toContain(CH3.slice(0, 40));
    const focus = focusOf(text);
    expect(focus.trimEnd().endsWith(MARKER)).toBe(true);
  });

  it('rewrite_selection, with focusFlowUp: the text before the selection, all of it, when the flowed-in budget covers it', () => {
    const selection = selectionOfFocus();
    const text = user(
      { tool: 'scene.draft', instruction: 'Rewrite.', mode: 'rewrite_selection', focus: FOCUS_ID, selection },
      { focusFlowUp: true },
    );
    expect(text).toContain(`Preceding text:\n${CH3.slice(0, selection.from)}\n\nSelection to rewrite:\n${selection.exact}`);
  });

  it('rewrite_selection: says so when the selection no longer matches, and sends no antecedent', () => {
    const assembled = assemble(
      {
        tool: 'scene.draft',
        instruction: 'Rewrite.',
        mode: 'rewrite_selection',
        focus: FOCUS_ID,
        selection: { from: 0, to: 12, exact: 'not in the text' },
      },
      buildApp(),
    );
    expect(assembled.layers[5]?.notes).toEqual([
      'The selection no longer matches the document, so the text before it is not sent.',
    ]);
    expect(assembled.messages[1]?.content).toContain('Preceding text:\n(none)');
  });

  it('synopsis.fill: the whole document, when it fits the layer budget', () => {
    const text = user({ tool: 'synopsis.fill', instruction: 'Summarise.', focus: FOCUS_ID });
    expect(text).toContain(`Document: Chapter 3 (full text; ${formatCount(CH3.length)} of ${formatCount(CH3.length)} characters)`);
    expect(text).toContain(CH3);
    expect(text).not.toContain('# Codex');
    expect(text).not.toContain('# Story so far');
  });

  it('synopsis.fill: cuts the document from the bottom, and says what was cut', () => {
    // L3 is held to zero so that none of its unused budget flows up into the document.
    const assembled = assemble(
      { tool: 'synopsis.fill', instruction: 'Summarise.', focus: FOCUS_ID },
      buildApp(),
      { layerBudgets: { L3: 0, L5: 50 } },
    );
    const text = assembled.messages[1]?.content ?? '';
    const shown = assembled.focus?.chars ?? 0;
    // The cap is 200 characters, and the heading and marker take most of it, so the head that
    // is left is short. The test reads the length the report gives, and checks it is a head.
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(CH3.length);
    expect(text).toContain(`(full text; ${formatCount(shown)} of ${formatCount(CH3.length)} characters, the rest is over the focus budget)`);
    expect(text).toContain(CH3.slice(0, shown));
    expect(text).not.toContain(CH3.slice(0, shown + 20));
    expect(assembled.layers[5]?.notes).toEqual([`The document is cut at ${formatCount(shown)} of ${formatCount(CH3.length)} characters.`]);
    expect(assembled.layers[5]?.tokens).toBeLessThanOrEqual(50);
  });

  it('continuity.scan: every scope document is sent, in scope order, with its extent', () => {
    const text = user({ tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch1, IDS.ch2, IDS.ch3] });
    const focus = text.slice(text.indexOf('# Focus'), text.indexOf('# Task'));
    expect(focus).toContain('Scope: documents in manuscript order; the last 4,000 characters of each.');
    expect(focus).toContain(`## Chapter 1 (all ${formatCount(CH1.length)} characters)`);
    expect(focus).toContain(`## Chapter 2 (all ${formatCount(CH2.length)} characters)`);
    expect(focus).toContain(`## Chapter 3 (all ${formatCount(CH3.length)} characters)`);
    expect(focus.indexOf('Chapter 1')).toBeLessThan(focus.indexOf('Chapter 2'));
    expect(focus.split(MARKER).length - 1).toBe(3);
  });

  it('continuity.scan past the document limit: the scope header says which documents are not sent', () => {
    const { app, ids } = scopeApp(22);
    const text = assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: ids }, app).messages[1]?.content ?? '';
    expect(text).toContain('Scope: first 20 of 22 documents sent; the rest are not.');
    expect(text).toContain('Text of part 20.');
    expect(text).not.toContain('Text of part 21.');
    expect(text).not.toContain('Text of part 22.');
  });
});

describe('L6, the recent turns (§2)', () => {
  it('keeps the last two turns, with intent, outcome and undo group, and names the rest', () => {
    const text = user(CONTINUE);
    const turns = text.slice(text.indexOf('# Recent turns'), text.indexOf('# Task'));
    expect(turns).not.toContain('t_1');
    expect(turns).toContain('- Turn t_2\n  Intent: Draft chapter 2 from the notes, keeping Hale gruff.');
    expect(turns).toContain('  Outcome: wrote 212 words into Chapter 2\n  Undo group: g_t2');
    expect(turns).toContain('  Outcome: trimmed 41 words from Chapter 3; set the status of Chapter 3 to revised');
    expect(turns).toContain('  Undo group: g_t3');
    expect(assemble(CONTINUE, buildApp()).layers[6]?.notes).toEqual([
      "1 earlier turn is not sent; the agent's tools can read them back.",
    ]);
  });

  it('is left out of the layers that do not take conversation memory', () => {
    const assembled = assemble({ tool: 'meta', instruction: 'x' }, buildApp());
    expect(assembled.layers[6]?.included).toBe(false);
    expect(assembled.messages[1]?.content).not.toContain('# Recent turns');
  });
});

describe('L7, the task (§2)', () => {
  it('sends the instruction verbatim, then the canonical parameters', () => {
    const instruction = 'Write the next scene:\n  keep the  spacing.';
    const text = user({ ...CONTINUE, instruction, params: { mode: 'continue', doc: FOCUS_ID } });
    expect(text.endsWith(`# Task\n\n${instruction}\n\nTool: scene.draft\nParameters: {"doc":"n_ch3","mode":"continue"}`)).toBe(true);
  });
});
