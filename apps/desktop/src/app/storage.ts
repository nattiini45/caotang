/**
 * The browser's storage durability (ui-modules §5.3): whether the browser has granted persistent storage to this origin,
 * and the usage and quota it reports. The browser's own answer is authoritative; the session only mirrors it.
 *
 * The request is made once, when a project is opened, and it is not asked again once granted. It is the browser's own
 * request: Caotang shows no modal for it. Every call is guarded, because a browser may have no storage manager (a private
 * window, a test host), and then the answer is "not known", which the banner treats as not granted.
 */
/* lingui-set comment="Interpolated values: size, total, used" */

import { t } from '@lingui/core/macro';
import { numberFormat } from '@caotang/i18n';

import { formatterLocale } from '../i18n/format-locale.js';
import type { Durability } from './session.js';

/** The part of `navigator.storage` the app uses. A test supplies its own. */
export interface StorageHost {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
  estimate(): Promise<{ usage?: number; quota?: number }>;
}

/** The browser's storage manager, or `null` where the browser has none. */
export function browserStorageHost(): StorageHost | null {
  const storage = (globalThis as unknown as { navigator?: { storage?: StorageHost } }).navigator?.storage;
  return storage ?? null;
}

const UNKNOWN: Durability = { persisted: null, usage: null, quota: null };

/**
 * The eviction banner's dismissal, for this visit (ui-modules §5.3, rule 3): once the writer has dismissed it, it is not shown
 * again until the page is loaded again. It is kept in memory, so the next visit asks again.
 */
let bannerDismissed = false;

export function isBannerDismissedForVisit(): boolean {
  return bannerDismissed;
}

export function dismissBannerForVisit(): void {
  bannerDismissed = true;
}

/** What the browser says now, without asking for anything. `null` fields mean the browser did not say. */
export async function readDurability(host: StorageHost | null): Promise<Durability> {
  if (host === null) return UNKNOWN;
  try {
    const persisted = await host.persisted();
    const estimate = await estimateOf(host);
    return { persisted, ...estimate };
  } catch {
    return UNKNOWN;
  }
}

/**
 * Asks the browser for persistent storage when it has not granted it, then reads the answer. A refusal is an answer, not an
 * error: the banner says so and the project stays open.
 */
export async function requestDurability(host: StorageHost | null): Promise<Durability> {
  if (host === null) return UNKNOWN;
  try {
    if (!(await host.persisted())) await host.persist();
    return await readDurability(host);
  } catch {
    return UNKNOWN;
  }
}

async function estimateOf(host: StorageHost): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const { usage, quota } = await host.estimate();
    return { usage: usage ?? null, quota: quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

/** The one sentence Settings shows for the storage row (ui-modules §5.3, rule 2), in the words the spec gives. */
export function durabilitySentence(durability: Durability): string {
  if (durability.persisted === true) return t`Browser storage: persistent ✓`;
  if (durability.persisted === false) {
    return t`Browser storage: persistence not granted — the browser may evict this project under storage pressure.`;
  }
  return t`Browser storage: the browser has not said whether it keeps this project.`;
}

/** The usage line Settings shows under it, when the browser gave an estimate. */
export function usageSentence(durability: Durability): string | null {
  if (durability.usage === null || durability.quota === null || durability.quota <= 0) return null;
  const used = formatBytes(durability.usage);
  const total = formatBytes(durability.quota);
  return t`Using about ${{ used }} of about ${{ total }} this browser allows for this site.`;
}

/** Bytes as a figure a writer reads: one decimal place in megabytes or gigabytes, never a bare number. */
export function formatBytes(bytes: number): string {
  const oneDecimal = numberFormat(formatterLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 1024 * 1024) return t`${{ size: numberFormat(formatterLocale()).format(Math.max(0, Math.round(bytes / 1024))) }} KB`;
  if (bytes < 1024 * 1024 * 1024) return t`${{ size: oneDecimal.format(bytes / (1024 * 1024)) }} MB`;
  return t`${{ size: oneDecimal.format(bytes / (1024 * 1024 * 1024)) }} GB`;
}
