/**
 * Modern's narrow panels, one at a time (components/shell/modern/narrow-sync.ts; modern-interface.md §13, #312): the workspace's
 * `openPanel`, its `agentOpen` and Scene info's store kept in agreement, whichever of them moved.
 */
import { describe, expect, it } from 'vitest';

import { DRAWER_TABS, drawerTabFor } from '../src/components/shell/modern/narrow-panels.js';
import { shownPanel, syncNarrow, type NarrowState } from '../src/components/shell/modern/narrow-sync.js';

const S = (over: Partial<NarrowState> = {}): NarrowState => ({ panel: null, agent: false, info: false, rail: 'binder', ...over });

/** Applies a change, as the component does. */
const apply = (state: NarrowState, change: ReturnType<typeof syncNarrow>): NarrowState => ({
  ...state,
  ...(change.panel === undefined ? {} : { panel: change.panel }),
  ...(change.agent === undefined ? {} : { agent: change.agent }),
  ...(change.info === undefined ? {} : { info: change.info }),
});

/** Runs the rule until nothing changes, as the renders that follow a change do; fails on a loop. */
function settle(previous: NarrowState, next: NarrowState): NarrowState {
  let before = previous;
  let now = next;
  for (let round = 0; round < 5; round += 1) {
    const change = syncNarrow(before, now);
    if (Object.keys(change).length === 0) return now;
    before = now;
    now = apply(now, change);
  }
  throw new Error('narrow sync did not settle');
}

describe('syncNarrow', () => {
  it('changes nothing while nothing moved', () => {
    expect(syncNarrow(S(), S())).toEqual({});
    expect(syncNarrow(S({ panel: 'rail' }), S({ panel: 'rail' }))).toEqual({});
  });

  it('an agent request opens the agent sheet over the drawer or Scene info, and the panel follows', () => {
    expect(settle(S({ panel: 'rail' }), S({ panel: 'rail', agent: true }))).toEqual(S({ panel: 'agent', agent: true }));
    expect(settle(S({ panel: 'inspector', info: true }), S({ panel: 'inspector', info: true, agent: true }))).toEqual(
      S({ panel: 'agent', agent: true }),
    );
    // runAgentIntent opens the agent and clears the panel in the same change: the agent wins.
    expect(settle(S({ panel: 'rail' }), S({ panel: null, agent: true }))).toEqual(S({ panel: 'agent', agent: true }));
  });

  it('Scene info opening takes the panel, and closes the agent sheet', () => {
    expect(settle(S(), S({ info: true }))).toEqual(S({ panel: 'inspector', info: true }));
    expect(settle(S({ panel: 'agent', agent: true }), S({ panel: 'agent', agent: true, info: true }))).toEqual(S({ panel: 'inspector', info: true }));
  });

  it('a route asking for the inspector panel opens Scene info', () => {
    expect(settle(S(), S({ panel: 'inspector' }))).toEqual(S({ panel: 'inspector', info: true }));
  });

  it('the drawer opening closes whatever sheet was open', () => {
    expect(settle(S({ panel: 'agent', agent: true }), S({ panel: 'rail', agent: true }))).toEqual(S({ panel: 'rail' }));
    expect(settle(S({ panel: 'inspector', info: true }), S({ panel: 'rail', info: true }))).toEqual(S({ panel: 'rail' }));
  });

  it('a sheet closing by itself (Close, Escape, Ask, Ctrl+J) closes its panel', () => {
    expect(settle(S({ panel: 'agent', agent: true }), S({ panel: 'agent' }))).toEqual(S());
    expect(settle(S({ panel: 'inspector', info: true }), S({ panel: 'inspector' }))).toEqual(S());
  });

  it('the panel closing (the scrim, a chosen scene) closes its sheet', () => {
    expect(settle(S({ panel: 'agent', agent: true }), S({ panel: null, agent: true }))).toEqual(S());
    expect(settle(S({ panel: 'inspector', info: true }), S({ panel: null, info: true }))).toEqual(S());
  });

  it('a codex request shows the Codex view and leaves the drawer closed', () => {
    expect(settle(S(), S({ panel: 'rail', rail: 'codex' }))).toEqual(S({ rail: 'codex' }));
    // The binder's button pressed while the page shows the Codex opens the drawer (on its Binder tab).
    expect(settle(S({ rail: 'codex' }), S({ panel: 'rail', rail: 'codex' }))).toEqual(S({ panel: 'rail', rail: 'codex' }));
  });

  it('entering the narrow layout with the agent open and Scene info docked keeps one sheet, the agent’s', () => {
    expect(settle(S(), S({ agent: true, info: true }))).toEqual(S({ panel: 'agent', agent: true }));
  });

  it('never loops, from any state to any state', () => {
    const panels = [null, 'rail', 'inspector', 'agent'] as const;
    const states: NarrowState[] = [];
    for (const panel of panels) for (const agent of [false, true]) for (const info of [false, true]) states.push(S({ panel, agent, info }));
    for (const from of states) {
      for (const to of states) {
        const end = settle(from, to);
        // At most one is open, and the panel names it.
        expect(Number(end.agent) + Number(end.info)).toBeLessThanOrEqual(1);
        if (end.agent) expect(end.panel).toBe('agent');
        if (end.info) expect(end.panel).toBe('inspector');
      }
    }
  });
});

describe('shownPanel', () => {
  it('is the sheet that is open, else the drawer', () => {
    expect(shownPanel(S())).toBeNull();
    expect(shownPanel(S({ panel: 'rail' }))).toBe('rail');
    expect(shownPanel(S({ panel: 'rail', agent: true }))).toBe('agent');
    expect(shownPanel(S({ info: true }))).toBe('inspector');
    expect(shownPanel(S({ panel: 'agent' }))).toBeNull();
  });
});

describe('the drawer’s tabs', () => {
  it('are the sidebar’s, and the Codex view shows the Binder tab', () => {
    expect(DRAWER_TABS).toEqual(['binder', 'findings', 'activity', 'trace']);
    expect(drawerTabFor('codex')).toBe('binder');
    expect(drawerTabFor('trace')).toBe('trace');
  });
});
