/**
 * The companion window's pure rules (M8, #309; modern-interface.md §8.3, §8.4, §8.10): where the window sits at each width the spec
 * names, the room it takes from the page, the morph's keyframes, the motion tokens it reads, and the open action #306's **Ask** calls.
 */
import { describe, expect, it } from 'vitest';

import {
  ASK_ID,
  COMPANION_ID,
  askState,
  noteCompanionOpener,
  openCompanion,
  takeCompanionOpener,
  toggleCompanion,
} from '../src/components/shell/modern/companion-actions.js';
import {
  COMPANION_GUTTER,
  COMPANION_WIDTH,
  companionAreaEnd,
  companionPlacement,
  durationMs,
  morphFrames,
} from '../src/components/shell/modern/companion-model.js';

describe('where the companion window sits (§8.4, §13)', () => {
  it('beside the page above 1,280 px, as a sheet from 1,280 px down to 960, and full width below', () => {
    expect(companionPlacement(1920)).toBe('beside');
    expect(companionPlacement(1440)).toBe('beside');
    expect(companionPlacement(1281)).toBe('beside');
    expect(companionPlacement(1280)).toBe('sheet');
    expect(companionPlacement(1100)).toBe('sheet');
    expect(companionPlacement(960)).toBe('sheet');
    expect(companionPlacement(959)).toBe('full');
    expect(companionPlacement(390)).toBe('full');
  });

  it('takes room from the page only while open beside it; a sheet overlaps', () => {
    expect(companionAreaEnd(1440, true)).toBe(COMPANION_WIDTH + COMPANION_GUTTER);
    expect(companionAreaEnd(1440, false)).toBe(0);
    expect(companionAreaEnd(1280, true)).toBe(0);
    expect(companionAreaEnd(800, true)).toBe(0);
  });
});

describe('the morph (§8.3)', () => {
  const ask = { left: 700, top: 820, width: 96, height: 48 };
  const pane = { left: 1008, top: 100, width: 400, height: 688 };

  it('starts over the opener and ends where the window is, scaling from its top-left corner', () => {
    const frames = morphFrames(ask, pane);
    expect(frames).not.toBeNull();
    const [first, last] = frames!;
    expect(first.transform).toBe('translate(-308px, 720px) scale(0.24, 0.07)');
    expect(first.transformOrigin).toBe('0 0');
    expect(first.opacity).toBeLessThan(1);
    expect(last).toEqual({ transform: 'none', transformOrigin: '0 0', opacity: 1 });
  });

  it('gives up for a box with no size, so the window fades instead', () => {
    expect(morphFrames({ left: 0, top: 0, width: 0, height: 0 }, pane)).toBeNull();
    expect(morphFrames(ask, { left: 0, top: 0, width: 400, height: 0 })).toBeNull();
  });

  it('reads the motion tokens, and a zero (reduced motion) as no morph', () => {
    expect(durationMs('520ms')).toBe(520);
    expect(durationMs(' 0.24s ')).toBe(240);
    expect(durationMs('0s')).toBe(0);
    expect(durationMs('')).toBe(0);
    expect(durationMs('var(--x)')).toBe(0);
  });
});

describe('the open action (#306’s Ask)', () => {
  function view(agentOpen = false) {
    const calls: boolean[] = [];
    return {
      calls,
      agentOpen,
      agentActivity: 'working' as const,
      setAgentOpen: (open: boolean) => {
        calls.push(open);
      },
    };
  }
  const control = (connected = true) => ({ isConnected: connected }) as unknown as Element;

  it('opens the window and remembers the control it grows out of, once', () => {
    const shell = view();
    const ask = control();
    openCompanion(shell, ask);
    expect(shell.calls).toEqual([true]);
    expect(takeCompanionOpener()).toBe(ask);
    expect(takeCompanionOpener()).toBeNull();
  });

  it('toggles: an open window closes, a closed one opens', () => {
    const closed = view(false);
    toggleCompanion(closed, control());
    expect(closed.calls).toEqual([true]);
    const open = view(true);
    toggleCompanion(open, control());
    expect(open.calls).toEqual([false]);
    takeCompanionOpener();
  });

  it('forgets an opener that has left the document or was noted long ago', () => {
    noteCompanionOpener(control(false));
    expect(takeCompanionOpener()).toBeNull();
    noteCompanionOpener(control());
    expect(takeCompanionOpener(Date.now() + 5000)).toBeNull();
  });

  it('tells Ask whether the window is open and what the agent is doing', () => {
    expect(askState(view(true))).toEqual({ expanded: true, activity: 'working' });
    expect(ASK_ID).toBe('modern-ask');
    expect(COMPANION_ID).toBe('modern-companion');
  });
});
