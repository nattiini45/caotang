import guideStatus from './guide-status.json';

const GUIDE_ROOT = 'https://github.com/nattiini45/caotang/blob/main/';

interface GuideSectionStatus {
  readonly hash: string;
  readonly anchor: string;
}

/**
 * Links to a translation only for a section whose source hash was current when the status file was generated.
 * Missing, stale, renamed and pseudo-locale sections use the authoritative English guide instead.
 */
export function guideHref(tag: string, sectionId: string): string {
  const sections = (guideStatus.locales as Readonly<Record<string, { sections: Readonly<Record<string, GuideSectionStatus>> }>>)[tag]?.sections;
  const translated = sections?.[sectionId];
  if (translated === undefined) return GUIDE_ROOT + 'docs/USER-GUIDE.md#' + sectionId;
  return GUIDE_ROOT + 'docs/i18n/' + tag + '/USER-GUIDE.md#' + translated.anchor;
}
