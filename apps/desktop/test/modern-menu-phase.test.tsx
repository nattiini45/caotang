// @vitest-environment jsdom

import { act, StrictMode, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlassPopover } from '../src/components/shell/modern/glass-popover.js';
import { morph } from '../src/components/shell/modern/morph.js';
import { useMenuPhase } from '../src/components/shell/modern/use-menu-phase.js';

vi.mock('../src/components/shell/modern/morph.js', () => ({ morph: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let menu: ReturnType<typeof useMenuPhase>;
const animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];

function MenuItems({ phase }: { phase: string }) {
  const item = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { item.current?.focus(); }, []);
  return <div role="menu" data-state={phase}><button ref={item} role="menuitem">Choose</button></div>;
}

function Harness({ fresh }: { fresh: boolean }) {
  const state = useMenuPhase();
  useLayoutEffect(() => { menu = state; });
  const opener = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={opener} data-testid="opener" onClick={state.toggle} aria-expanded={state.phase === 'open'}>Menu</button>
    <button data-testid="outside">Elsewhere</button>
    {state.phase === 'closed' ? null : <GlassPopover
      key={fresh ? state.opening : 'retained'}
      opener={opener}
      closing={state.phase === 'closing'}
      onDismiss={state.close}
      onClosed={state.onClosed}
      testId="popover"
    ><MenuItems phase={state.phase} /></GlassPopover>}
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  animations.length = 0;
  vi.mocked(morph).mockImplementation((_target, _opener, direction) => {
    if (direction === 'open') return null;
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const timer = window.setTimeout(finish, 240);
    const cancel = vi.fn(() => { window.clearTimeout(timer); reject(new Error('Cancelled')); });
    animations.push({ cancel, finish });
    return { finished, cancel } as unknown as Animation;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

for (const fresh of [true, false]) {
  describe(`the shared menu phase with a ${fresh ? 'fresh' : 'retained'} popover`, () => {
    beforeEach(async () => {
      await act(async () => root.render(<StrictMode><Harness fresh={fresh} /></StrictMode>));
    });

    it('returns focus immediately but stays closing until the animation finishes', async () => {
      expect(menu.phase).toBe('closed');
      await act(async () => menu.toggle());
      expect(host.querySelector('[role="menu"]')?.getAttribute('data-state')).toBe('open');
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
      await act(async () => menu.close());
      expect(menu.phase).toBe('closing');
      expect(host.querySelector('[role="menu"]')?.getAttribute('data-state')).toBe('closing');
      expect(host.querySelector('[data-testid="popover"]')?.hasAttribute('inert')).toBe(true);
      expect(document.activeElement?.getAttribute('data-testid')).toBe('opener');
      await act(async () => vi.advanceTimersByTimeAsync(239));
      expect(menu.phase).toBe('closing');
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(menu.phase).toBe('closed');
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reopens during close, cancels the old animation timer and ignores its completion', async () => {
      await act(async () => menu.open());
      await act(async () => menu.close());
      const oldClosed = menu.onClosed;
      const oldAnimation = animations.at(-1)!;
      await act(async () => menu.toggle());
      expect(menu.phase).toBe('open');
      expect(menu.opening).toBe(2);
      expect(oldAnimation.cancel).toHaveBeenCalledOnce();
      expect(host.querySelector('[data-testid="popover"]')?.hasAttribute('inert')).toBe(false);
      await act(async () => menu.close());
      await act(async () => { oldClosed(); oldAnimation.finish(); });
      expect(menu.phase).toBe('closing');
      await act(async () => vi.advanceTimersByTimeAsync(240));
      expect(menu.phase).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('cleans up its animation and placement timers when unmounted during close', async () => {
      await act(async () => menu.open());
      await act(async () => menu.close());
      const animation = animations.at(-1)!;
      await act(async () => root.render(null));
      expect(animation.cancel).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { animation.finish(); await vi.runAllTimersAsync(); });
      expect(host.children).toHaveLength(0);
    });

    it('leaves focus outside alone, and dismisses from Escape or a pointer outside', async () => {
      await act(async () => menu.open());
      const outside = host.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
      outside.focus();
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(menu.phase).toBe('closing');
      expect(document.activeElement).toBe(outside);
      await act(async () => vi.advanceTimersByTimeAsync(240));
      await act(async () => menu.open());
      await act(async () => outside.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(menu.phase).toBe('closing');
    });
  });
}
