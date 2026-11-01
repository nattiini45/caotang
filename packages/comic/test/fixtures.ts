import type { Balloon, ComicPage, Panel, Rect } from '../src/index.js';

export function balloon(id: string, text: string, extra: Partial<Balloon> = {}): Balloon {
  return { id, kind: 'speech', text, rect: [0.1, 0.1, 0.3, 0.15], ...extra };
}

export function panel(id: string, balloons: Balloon[] = [], rect: Rect = [0, 0, 1, 0.5], extra: Partial<Panel> = {}): Panel {
  return { id, rect, balloons, ...extra };
}

export function page(panels: Panel[], extra: Partial<ComicPage> = {}): ComicPage {
  return { size: 'us-comic', panels, ...extra };
}

export const words = (n: number, word = 'word'): string => Array.from({ length: n }, () => word).join(' ');
