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

/**
 * A project whose words live on the account, handed over by a host before the app boots. It is the one way the remote
 * adapter is ever reached: without this, the app opens projects the way it always has, from this browser or a folder, and
 * nothing imports `@caotang/remote-store`. What crosses is the origin that serves the project's routes (the shell's, not
 * this frame's), the id the server knows, the device label this session keeps, and the project key as a non-extractable
 * `CryptoKey` — so the app seals every file with a key derived from one it cannot export, and the shell never sees a
 * manuscript's key in bytes.
 */
export interface HostedProjectSource {
  readonly projectId: string;
  readonly origin: string;
  /** At most 64 letters, digits, `-` and `_`; the same label goes on every write and names this device's lease. */
  readonly device: string;
  readonly key: CryptoKey;
}

let host: StudioHost | null = null;
let handedProject: HostedProjectSource | null = null;

/**
 * Names the project a hosted frame opens. The host sets this before the studio boots and clears it on a lock, so a frame
 * that outlives a sign-out opens nothing from the account after it.
 */
export function setHostedProject(next: HostedProjectSource | null): void {
  handedProject = next;
}

/** The project the host handed this frame, or null for the app's own opens. */
export function hostedProject(): HostedProjectSource | null {
  return handedProject;
}

/** Sets the host before the app boots; passing null clears it, which a host does when it signs out. */
export function setStudioHost(next: StudioHost | null): void {
  host = next;
}

export function studioHost(): StudioHost | null {
  return host;
}
