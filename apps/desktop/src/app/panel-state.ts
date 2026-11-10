export type PanelState = 'loading' | 'empty' | 'error' | 'off' | 'partial' | 'conflict';

export function panelState(state: PanelState): { readonly 'data-panel-state': PanelState } {
  return { 'data-panel-state': state };
}
