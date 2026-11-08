import { useLayoutEffect } from 'react';

export function useVisualKeyboard(): void {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const stage = document.querySelector<HTMLElement>('.modern-stage');
    if (viewport === null || stage === null) return;
    const touch = window.matchMedia('(pointer: coarse)');
    const update = (): void => {
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && stage.contains(active) &&
        (active.isContentEditable || active.matches('textarea, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="range"], [type="color"], [type="file"])'));
      stage.toggleAttribute('data-visual-keyboard', touch.matches && editing && viewport.scale === 1 && window.innerHeight - viewport.height > 150);
    };
    viewport.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    update();
    return () => {
      viewport.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      stage.removeAttribute('data-visual-keyboard');
    };
  }, []);
}
