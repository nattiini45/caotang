/**
 * The one place a host of the studio app hooks into it — the hosted instance's shell is the only user today. The app is
 * otherwise the same whether it runs from a folder or from a hosted origin, so the host's part is deliberately small: it
 * is told when a provider key changes, and it can supply keys this device has not got. Nothing here decides what a key
 * is or where it is sealed; the app still owns that, and a host that sets nothing changes nothing.
 *
 * `keyChanged` must not throw: the key is already stored when it runs, so a failure there is the host's to report to the
 * writer, not a reason for a save to fail.
 */
import type { KeyChange, KeyPayload } from '@caotang/gateway';

export interface StudioHost {
  /**
   * A provider key was written or removed for `profileId`. `change` is null when it went away, and otherwise carries the
   * payload and the endpoint origin it belongs to — the copy a host keeps elsewhere is sealed against that origin, and
   * nothing in the app can reconstruct it later.
   */
  keyChanged?(profileId: string, change: KeyChange | null): void;
  /**
   * Keys for profiles this device has none for, installed before the stored profiles are read, so a profile whose key
   * lives on the account opens here instead of being left out with a notice. `origins` names where each stored profile
   * points: a key returns only for the origin it was entered for, because a secret may not travel to another address
   * just because another device edited the profile.
   */
  restore?(origins: ReadonlyMap<string, string>): Promise<readonly { readonly profileId: string; readonly payload: KeyPayload }[]>;
}

let host: StudioHost | null = null;

/** Sets the host before the app boots; passing null clears it, which a host does when it signs out. */
export function setStudioHost(next: StudioHost | null): void {
  host = next;
}

export function studioHost(): StudioHost | null {
  return host;
}
