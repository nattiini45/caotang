/**
 * The export's own front matter (#293): `info.json`, `campaign.json` and `settings/modules.json`. The version gate
 * lives here: Kanka below 2.1 wrote a different entity shape, so an older export is refused rather than half-read.
 */

export interface KankaInfo {
  kankaVersion: string;
  exportVersion: string;
  started: string;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** `info.json`, or null when the file is not one. */
export function parseInfo(json: unknown): KankaInfo | null {
  const file = record(json);
  const kankaVersion = text(file['kanka_version']).trim();
  if (kankaVersion === '') return null;
  return { kankaVersion, exportVersion: text(file['export_version']).trim(), started: text(file['started']).trim() };
}

/**
 * Whether a version string is at least `major.minor`. Only the first two parts decide: Kanka writes `2.1`, `2.1.4`
 * and sometimes a suffix. A version that cannot be read is not at least anything, so the caller refuses it.
 */
export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const foundMajor = Number(match[1]);
  const foundMinor = Number(match[2]);
  return foundMajor > major || (foundMajor === major && foundMinor >= minor);
}

/** The campaign's name, from `campaign.json`. */
export function campaignName(json: unknown): string {
  return text(record(json)['name']).trim();
}

/**
 * What the campaign calls each module, from `settings/modules.json`: `{ characters: { name_singular, name_plural } }`.
 * A module the campaign did not rename is absent, and the caller uses the folder's own name.
 */
export function moduleLabels(json: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [module, value] of Object.entries(record(json))) {
    const row = record(value);
    const label = text(row['name_plural']).trim() || text(row['name_singular']).trim();
    if (label !== '') labels.set(module, label);
  }
  return labels;
}
