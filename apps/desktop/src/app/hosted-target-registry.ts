/**
 * Which hosted project's save target is live, kept apart from the target itself — hosted.md §7.2. The app's open path has to ask for a
 * project's target and install the one it built, and both are only ever a lookup: keeping the registry in its own module is what keeps
 * `HostedTarget` (and the queue port and the digest helpers beside it) out of the first load, where `caotang.app` pays for nothing hosted.
 */
import type { HostedTarget } from './hosted-target.js';

const targets = new Map<string, HostedTarget>();

/**
 * Installs a target for the project it saves, replacing any earlier one: a session still closing must not commit its older state over
 * the project the writer has just opened, so the target installed before stops listening first.
 */
export function installHostedTarget(target: HostedTarget): void {
  const stale = targets.get(target.projectId);
  if (stale !== undefined && stale !== target) stale.detach();
  targets.set(target.projectId, target);
}

export function hostedTargetFor(projectId: string): HostedTarget | null {
  return targets.get(projectId) ?? null;
}

export function forgetHostedTarget(projectId: string): void {
  targets.delete(projectId);
}
