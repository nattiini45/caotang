import { useCallback, useReducer } from 'react';

import { menuStep, type MenuState } from './menu-model.js';

export function useMenuPhase(): {
  readonly phase: MenuState['kind'];
  readonly opening: number;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly onClosed: () => void;
} {
  const [state, send] = useReducer(menuStep, { kind: 'closed', opening: 0 });
  const open = useCallback(() => send({ type: 'open' }), []);
  return {
    phase: state.kind,
    opening: state.opening,
    open,
    close: () => send({ type: 'close' }),
    toggle: () => send({ type: 'toggle' }),
    onClosed: () => send({ type: 'closed', opening: state.opening }),
  };
}
