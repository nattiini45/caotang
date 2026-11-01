/**
 * Scene info's pure rules (modern-interface.md §8.2, §8.3; #308): the popover anchored to its opener, flipped and clamped into the
 * window; the entrance (a morph, or a fade under reduced motion); the FLIP transform; **Keep open** in local storage; and the open
 * API the title capsule (#306) calls, with the inspector request the routes send.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  POPOVER_GAP,
  POPOVER_WIDTH,
  SCENE_INFO_DOCKED_KEY,
  VIEWPORT_MARGIN,
  durationMs,
  entranceOf,
  morphFrom,
  placePopover,
  readDocked,
  writeDocked,
  type DockStore,
} from '../src/components/shell/modern/scene-info-model.js';
import {
  closeSceneInfo,
  openSceneInfo,
  resetSceneInfo,
  sceneInfoState,
  subscribeSceneInfo,
  toggleSceneInfo,
} from '../src/components/shell/modern/scene-info-store.js';
import { requestInspector } from '../src/app/inspector-request.js';

const WINDOW = { width: 1440, height: 900 };

describe('placePopover', () => {
  it('centres the popover under its opener, a gap below it', () => {
    const capsule = { left: 620, top: 70, width: 200, height: 56 };
    const place = placePopover(capsule, WINDOW);
    expect(place.side).toBe('below');
    expect(place.width).toBe(POPOVER_WIDTH);
    expect(place.left).toBe(720 - POPOVER_WIDTH / 2);
    expect(place.top).toBe(70 + 56 + POPOVER_GAP);
    expect(place.bottom).toBeNull();
    expect(place.maxHeight).toBe(900 - (70 + 56) - POPOVER_GAP - VIEWPORT_MARGIN);
  });

  it('clamps into the window at either edge', () => {
    expect(placePopover({ left: 0, top: 70, width: 44, height: 44 }, WINDOW).left).toBe(VIEWPORT_MARGIN);
    expect(placePopover({ left: 1400, top: 70, width: 40, height: 44 }, WINDOW).left).toBe(1440 - VIEWPORT_MARGIN - POPOVER_WIDTH);
  });

  it('flips above an opener near the foot of the window, when there is more room above', () => {
    const place = placePopover({ left: 600, top: 800, width: 120, height: 44 }, WINDOW);
    expect(place.side).toBe('above');
    expect(place.top).toBeNull();
    expect(place.bottom).toBe(900 - 800 + POPOVER_GAP);
    expect(place.maxHeight).toBe(800 - POPOVER_GAP - VIEWPORT_MARGIN);
  });

  it('narrows to the window and never goes negative', () => {
    const place = placePopover({ left: 10, top: 10, width: 44, height: 44 }, { width: 300, height: 200 });
    expect(place.width).toBe(300 - 2 * VIEWPORT_MARGIN);
    expect(place.left).toBe(VIEWPORT_MARGIN);
    expect(place.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it('with no opener, sits at the top centre where the title capsule is', () => {
    const place = placePopover(null, WINDOW);
    expect(place.left).toBe((1440 - POPOVER_WIDTH) / 2);
    expect(place.top).toBe(99);
  });
});

describe('the entrance', () => {
  it('reads CSS times', () => {
    expect(durationMs('520ms')).toBe(520);
    expect(durationMs('0.24s')).toBe(240);
    expect(durationMs('0s')).toBe(0);
    expect(durationMs('')).toBe(0);
    expect(durationMs('fast')).toBe(0);
  });

  it('morphs out of the opener, and fades in place under reduced motion or with no opener', () => {
    expect(entranceOf(520, true)).toBe('morph');
    expect(entranceOf(0, true)).toBe('fade');
    expect(entranceOf(520, false)).toBe('fade');
  });

  it('starts the morph over the opener’s box', () => {
    expect(morphFrom({ left: 620, top: 70, width: 200, height: 50 }, { left: 520, top: 138, width: 400, height: 500 })).toBe(
      'translate(100px,-68px) scale(0.5,0.1)',
    );
  });
});

describe('Keep open', () => {
  function memory(): DockStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  }

  it('is kept as "docked" and forgotten when turned off', () => {
    const store = memory();
    expect(readDocked(store)).toBe(false);
    writeDocked(true, store);
    expect(store.data.get(SCENE_INFO_DOCKED_KEY)).toBe('docked');
    expect(readDocked(store)).toBe(true);
    writeDocked(false, store);
    expect(store.data.has(SCENE_INFO_DOCKED_KEY)).toBe(false);
  });

  it('survives a store that refuses', () => {
    const refusing: DockStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readDocked(refusing)).toBe(false);
    expect(() => writeDocked(true, refusing)).not.toThrow();
    expect(readDocked(null)).toBe(false);
  });
});

describe('the open API', () => {
  afterEach(() => resetSceneInfo());

  it('opens on a field, counts each request, and closes', () => {
    const seen: boolean[] = [];
    const stop = subscribeSceneInfo(() => seen.push(sceneInfoState().open));
    openSceneInfo({ focus: 'synopsis' });
    const first = sceneInfoState();
    expect(first.open).toBe(true);
    expect(first.focus).toBe('synopsis');
    openSceneInfo();
    expect(sceneInfoState().request).toBe(first.request + 1);
    expect(sceneInfoState().focus).toBe('first');
    closeSceneInfo({ returnFocus: false });
    expect(sceneInfoState().open).toBe(false);
    stop();
    expect(seen).toEqual([true, true, false]);
  });

  it('toggles from its opener', () => {
    toggleSceneInfo(null);
    expect(sceneInfoState().open).toBe(true);
    toggleSceneInfo(null);
    expect(sceneInfoState().open).toBe(false);
  });

  it('forgets the open state when the workspace leaves', () => {
    openSceneInfo();
    resetSceneInfo();
    expect(sceneInfoState().open).toBe(false);
  });

  it('an inspector request outside a browser is answered by nobody', () => {
    expect(requestInspector('synopsis')).toBe(false);
  });
});
