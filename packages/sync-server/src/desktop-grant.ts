export interface DesktopGrantAccount {
  readonly id: string;
  readonly githubId: string;
  readonly revision: number;
}

type DesktopGrant = { readonly state: 'approved'; readonly account: DesktopGrantAccount } | { readonly state: 'closed' };
export type DesktopGrantResult =
  | { readonly kind: 'closed' | 'pending' | 'approved' }
  | { readonly kind: 'redeemed'; readonly account: DesktopGrantAccount };
export type DesktopGrantAction =
  | { readonly kind: 'approve'; readonly account: DesktopGrantAccount }
  | { readonly kind: 'redeem' | 'cancel' };

const KEY = 'desktop-grant';

export function settleDesktopGrant(
  storage: DurableObjectStorage,
  action: DesktopGrantAction,
  expires: number,
): Promise<DesktopGrantResult> {
  return storage.transaction(async (txn): Promise<DesktopGrantResult> => {
    if (Date.now() >= expires) return { kind: 'closed' };
    const saved = await txn.get<DesktopGrant>(KEY);
    if (saved?.state === 'closed') return { kind: 'closed' };
    if (action.kind === 'approve') {
      if (saved) return { kind: 'closed' };
      await txn.put<DesktopGrant>(KEY, { state: 'approved', account: action.account });
      await txn.setAlarm(expires);
      return { kind: 'approved' };
    }
    if (action.kind === 'redeem' && saved === undefined) return { kind: 'pending' };
    await txn.put<DesktopGrant>(KEY, { state: 'closed' });
    await txn.setAlarm(expires);
    return action.kind === 'redeem' && saved ? { kind: 'redeemed', account: saved.account } : { kind: 'closed' };
  });
}

export async function forgetDesktopGrant(storage: DurableObjectStorage): Promise<boolean> {
  return storage.delete(KEY);
}
