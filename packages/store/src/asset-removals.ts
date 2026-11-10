/**
 * The picture files a sweep is removing right now ([pictures.md §6.6.1](docs/architecture/pictures.md)). A sweep's last check that a
 * file has no use and its removal are one step only if nothing can add a use in between, and the removal is asynchronous, so a
 * document write landing while it is in flight could name a file that is about to vanish. The sweep holds each file here from that
 * last check until its removal settles, and the one body write every command goes through (`setBody`, `addDocument`) refuses a body
 * that newly names a held file. Kept apart from picture-retention.ts so state.ts can read it without an import cycle.
 */
import { ApplyRefusal } from '@caotang/bus';
import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

/** An `assets/a_XXXXXXXXXX.png` spelling anywhere in a text (the inline form, with or without `../`). */
const ASSET_PATH_IN_TEXT = /assets\/(a_[0-9A-HJKMNP-TV-Z]{10})\.(?:png|jpg|webp)\b/g;

/** Every asset id a text spells as a path (`../assets/a_….png`, `assets/a_….png`). */
export function assetIdsInText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(ASSET_PATH_IN_TEXT)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

export type AssetRemovalHoldState =
  | { readonly kind: 'clear' }
  | { readonly kind: 'held'; readonly holders: readonly object[] };

export type AssetRemovalHoldEvent =
  | { readonly type: 'acquire'; readonly holder: object }
  | { readonly type: 'release'; readonly holder: object };

export const assetRemovalHoldTable: MachineTable<AssetRemovalHoldState, AssetRemovalHoldEvent> = {
  id: 'asset.removal-hold',
  initial: 'clear',
  final: [],
  on: {
    clear: { acquire: ['held'] },
    held: { acquire: ['held'], release: ['held', 'clear'] },
  },
};

export function stepAssetRemovalHold(state: AssetRemovalHoldState, event: AssetRemovalHoldEvent): AssetRemovalHoldState {
  switch (state.kind) {
    case 'clear':
      switch (event.type) {
        case 'acquire': return { kind: 'held', holders: [event.holder] };
        case 'release': return state;
        default: return assertNever(event);
      }
    case 'held':
      switch (event.type) {
        case 'acquire': return state.holders.includes(event.holder) ? state : { kind: 'held', holders: [...state.holders, event.holder] };
        case 'release': {
          if (!state.holders.includes(event.holder)) return state;
          const holders = state.holders.filter((holder) => holder !== event.holder);
          return holders.length === 0 ? { kind: 'clear' } : { kind: 'held', holders };
        }
        default: return assertNever(event);
      }
    default: return assertNever(state);
  }
}

export const assetRemovalHoldMachine = defineMachine(assetRemovalHoldTable, stepAssetRemovalHold);

const held = new WeakMap<object, Map<string, AssetRemovalHoldState>>();

/**
 * Holds `assetId` against new references in `state` until the returned release runs. Call it in the same synchronous step as the
 * last use check, and release once the removal has settled (in a `finally`), so no write can slip between the check and the removal.
 */
export function holdAssetRemoval(state: object, assetId: string): () => void {
  let ids = held.get(state);
  if (ids === undefined) {
    ids = new Map();
    held.set(state, ids);
  }
  const holder = {};
  ids.set(assetId, assetRemovalHoldMachine.step(ids.get(assetId) ?? { kind: 'clear' }, { type: 'acquire', holder }));
  return () => {
    const current = held.get(state);
    const active = current?.get(assetId);
    if (current === undefined || active === undefined) return;
    const next = assetRemovalHoldMachine.step(active, { type: 'release', holder });
    if (next.kind === 'clear') current.delete(assetId);
    else current.set(assetId, next);
  };
}

/** Whether a sweep is removing `assetId`'s file in `state` right now. */
export function assetRemovalHeld(state: object, assetId: string): boolean {
  return held.get(state)?.get(assetId)?.kind === 'held';
}

/**
 * Refuses a body write that would newly name a picture whose file a sweep is removing. A body that already named it keeps naming
 * it (that use was there for the sweep's check to see, so the file is not being removed), and with no removal in flight this costs
 * one map read. The refusal is a revision conflict: the write can be made again once the sweep has finished.
 */
export function refuseReferenceToRemoval(state: object, before: string, after: string): void {
  const ids = held.get(state);
  if (ids === undefined || ids.size === 0) return;
  const had = new Set(assetIdsInText(before));
  for (const id of assetIdsInText(after)) {
    if (had.has(id) || !ids.has(id)) continue;
    throw new ApplyRefusal({
      code: 'revision-conflict',
      message: `the picture "${id}" is being removed by a sweep right now, so a text that names it was not written`,
      target: 'body',
      correctiveHint: 'wait for the sweep to finish, then import the picture again and write the text with its new name',
    });
  }
}
