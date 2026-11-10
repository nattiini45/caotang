import { assertNever, defineMachine } from '@caotang/machine';
import type { DecodableEncoding, EncodingDetection, EncodingIssue } from '@caotang/store';

interface ReadyPanel {
  readonly bytes: Uint8Array;
  readonly detection: EncodingDetection;
  readonly chosen: DecodableEncoding | undefined;
  readonly action: 'leave' | 'convert';
}

export type EncodingPanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreadable'; readonly error: string }
  | (ReadyPanel & { readonly kind: 'ready'; readonly aiNote?: string })
  | (ReadyPanel & { readonly kind: 'asking'; readonly request: number })
  | { readonly kind: 'closed' };

export type EncodingPanelEvent =
  | { readonly type: 'loaded'; readonly bytes: Uint8Array; readonly detection: EncodingDetection; readonly issue: EncodingIssue }
  | { readonly type: 'unreadable'; readonly error: string }
  | { readonly type: 'choose'; readonly encoding: DecodableEncoding }
  | { readonly type: 'action'; readonly action: 'leave' | 'convert' }
  | { readonly type: 'ask'; readonly request: number }
  | { readonly type: 'answered'; readonly request: number; readonly encoding?: DecodableEncoding; readonly note: string }
  | { readonly type: 'close' };

export const encodingPanelMachine = defineMachine<EncodingPanelState, EncodingPanelEvent>({
  id: 'ui.encoding.panel',
  initial: 'loading',
  final: ['closed'],
  on: {
    loading: { loaded: ['ready'], unreadable: ['unreadable'], close: ['closed'] },
    unreadable: { close: ['closed'] },
    ready: { choose: ['ready'], action: ['ready'], ask: ['asking'], close: ['closed'] },
    asking: { choose: ['ready'], action: ['ready'], answered: ['asking', 'ready'], close: ['closed'] },
    closed: {},
  },
}, (state, event) => {
  switch (event.type) {
    case 'loaded': {
      if (state.kind !== 'loading') return state;
      const { detection, issue } = event;
      const chosen = detection.best !== 'unknown' && detection.best !== 'utf-8'
        ? detection.best
        : issue.encoding !== 'unknown' ? issue.encoding : detection.candidates[0]?.encoding;
      return { kind: 'ready', bytes: event.bytes, detection, chosen, action: 'leave' };
    }
    case 'unreadable': return state.kind === 'loading' ? { kind: 'unreadable', error: event.error } : state;
    case 'choose':
    case 'action': {
      if (state.kind !== 'ready' && state.kind !== 'asking') return state;
      return {
        kind: 'ready', bytes: state.bytes, detection: state.detection,
        chosen: event.type === 'choose' ? event.encoding : state.chosen,
        action: event.type === 'action' ? event.action : state.action,
      };
    }
    case 'ask': {
      if (state.kind !== 'ready') return state;
      return { kind: 'asking', bytes: state.bytes, detection: state.detection, chosen: state.chosen, action: state.action, request: event.request };
    }
    case 'answered': {
      if (state.kind !== 'asking' || state.request !== event.request) return state;
      return { kind: 'ready', bytes: state.bytes, detection: state.detection, chosen: event.encoding ?? state.chosen, action: state.action, aiNote: event.note };
    }
    case 'close': return state.kind === 'closed' ? state : { kind: 'closed' };
    default: return assertNever(event);
  }
});
