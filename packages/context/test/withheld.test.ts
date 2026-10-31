/**
 * A read-deny keeps nodes out of a prompt (context-assembly §2, "Withheld"): the withheld text is absent from the bytes the
 * provider is sent, the preview lists every item left out, and an entry attached only to withheld nodes goes with them.
 */
import { describe, expect, it } from 'vitest';

import { ContextError, assemble, buildPreview, toChatMessages, withhold, type AgentTask, type AppSnapshot } from '../src/index.js';
import { CH1, CH2, FOCUS_ID, IDS, RESEARCH_NOTES, buildApp } from './fixtures.js';

const DRAFT: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene: Elena meets Mara again.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

/** The fixture, with the turn that wrote into Chapter 2 recorded against that node, as the activity log records it. */
function appWith(withheld: ReadonlySet<string> | undefined): AppSnapshot {
  const app = buildApp();
  const activity = (app.activity ?? []).map((row) =>
    row.summary.includes('Chapter 2') ? { ...row, affected: [{ nodeId: IDS.ch2, title: 'Chapter 2' }] } : row,
  );
  return { ...app, activity, ...(withheld === undefined ? {} : { withheld }) };
}

const bytesOf = (task: AgentTask, withheld: ReadonlySet<string> | undefined): string => JSON.stringify(toChatMessages(assemble(task, appWith(withheld))));

describe('assembly with a withheld set', () => {
  const hidden = new Set<string>([IDS.ch1, IDS.ch2, IDS.notes]);

  it('is the same prompt when nothing is withheld', () => {
    expect(bytesOf(DRAFT, new Set())).toBe(bytesOf(DRAFT, undefined));
  });

  it('leaves the withheld text, titles and synopses out of every byte the provider is sent', () => {
    const open = bytesOf(DRAFT, undefined);
    expect(open).toContain('Chapter 1');
    expect(open).toContain('Research notes');
    const sent = bytesOf(DRAFT, hidden);
    for (const gone of ['Chapter 1', 'Chapter 2', 'wrote 212 words', 'Research notes', CH1.slice(0, 60), CH2.slice(0, 60), RESEARCH_NOTES, 'chandlery', 'Fog behaviour']) {
      expect(sent, gone).not.toContain(gone);
    }
    // What is not withheld is still there.
    expect(sent).toContain('Chapter 3');
    expect(sent).toContain('Act I');
  });

  it('withholds a whole subtree and the codex entry attached only to it, and keeps an entry attached to nothing', () => {
    const sent = bytesOf(DRAFT, new Set([IDS.act1, IDS.ch1, IDS.ch2, IDS.ch3].filter((id) => id !== FOCUS_ID)));
    // Mara is attached to Act I alone, and Act I is withheld here; her entry goes with it.
    const all = bytesOf({ ...DRAFT, instruction: 'Mara keeps the log.' }, undefined);
    expect(all).toContain('Mara keeps the lighthouse log');
    const partly = bytesOf({ ...DRAFT, instruction: 'Mara keeps the log.' }, new Set([IDS.act1, IDS.ch1, IDS.ch2]));
    expect(partly).not.toContain('Mara keeps the lighthouse log');
    expect(partly).toContain('A fog-bound port town');
    expect(sent).toContain('Chapter 3');
  });

  it('lists each item it left out in the preview, by title, and says so in the project layer', () => {
    const assembled = assemble(DRAFT, { ...buildApp(), withheld: hidden });
    const preview = buildPreview(assembled);
    const project = preview.layers.find((layer) => layer.id === 'L1');
    expect(project?.drops.map((drop) => drop.label).sort()).toEqual(['Chapter 1 (document)', 'Chapter 2 (document)', 'Research notes (document)'].sort());
    for (const drop of project?.drops ?? []) expect(drop.text).toContain('withheld by a read rule');
    expect(project?.notes.join(' ')).toContain('3 items are withheld');
  });

  it('refuses a focus that is withheld, since the harness refuses such a call first', () => {
    expect(() => assemble(DRAFT, { ...buildApp(), withheld: new Set([FOCUS_ID]) })).toThrow(ContextError);
  });

  it('drops a withheld document from a continuity scope, and reads the manuscript without it by default', () => {
    const scan: AgentTask = { tool: 'continuity.scan', instruction: 'Check the timeline.', params: {}, scope: [IDS.ch1, IDS.ch3] };
    const sent = bytesOf(scan, new Set([IDS.ch1]));
    expect(sent).not.toContain(CH1.slice(0, 60));
    expect(sent).toContain('Chapter 3');
    const whole = bytesOf({ ...scan, scope: undefined }, new Set([IDS.ch1]));
    expect(whole).not.toContain(CH1.slice(0, 60));
  });

  it('does not touch the project it was given', () => {
    const app = { ...buildApp(), withheld: hidden };
    const before = JSON.stringify(app.state.manifest.tree);
    withhold(DRAFT, app);
    expect(JSON.stringify(app.state.manifest.tree)).toBe(before);
    expect(app.state.documents.has(IDS.ch1)).toBe(true);
  });
});
