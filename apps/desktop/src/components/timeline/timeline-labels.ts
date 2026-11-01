/**
 * The words `@caotang/timeline` writes, in the project's language ([timeline.md §3.2](docs/architecture/timeline.md), i18n.md §3.1).
 *
 * The axis, the folds and the chip names are about the book, so they follow the project language; the controls around them follow
 * the interface. Only the English catalogue ships today, so a project whose language has no catalogue here gets the interface's own
 * words and numbers, never English words with another language's digits. `useLabelCatalogue` picks the catalogue; the descriptors
 * below are the messages it renders.
 */

import { I18n, i18n as uiCatalogue, type MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import type { DayLensMessages, StoryPart, TimelineLabels } from '@caotang/timeline';

import { catalogueTags } from '../../i18n/catalogues.js';
import { formatterLocale } from '../../i18n/format-locale.js';
import { loadMessages } from '../../i18n/runtime.js';

/* lingui-set comment="Words on the story timeline's axis and in a scene's accessible name. Interpolated values: days, count, n, text, span, anchor, lower, rest, dayLabel, endLabel, durationDays, openFindings, title, part, name, names, folder." */

export interface LabelCatalogue {
  readonly instance: I18n;
  /** The locale numbers in the labels are written in. */
  readonly locale: string;
}

const SEPARATOR = ' \u00b7 ';

/** The shipped catalogue tag for the project's language, or `undefined` when this build has none. */
export function catalogueTagFor(language: string | undefined, dev: boolean = import.meta.env.DEV): string | undefined {
  if (language === undefined || language === '') return undefined;
  const wanted = language.toLowerCase();
  return catalogueTags(dev).find((tag) => tag.toLowerCase() === wanted);
}

/**
 * The catalogue the labels render in. The interface's own while the project's language has no catalogue or that one is still
 * loading; a separate instance for the project's language once it is, so the interface's language never changes.
 */
export function useLabelCatalogue(language: string | undefined): LabelCatalogue {
  const tag = catalogueTagFor(language);
  const [loaded, setLoaded] = useState<{ tag: string; instance: I18n } | null>(null);
  useEffect(() => {
    if (tag === undefined || tag === uiCatalogue.locale) return;
    let alive = true;
    void loadMessages(tag).then((messages) => {
      if (!alive) return;
      const instance = new I18n({});
      instance.load(tag, messages);
      instance.activate(tag);
      setLoaded({ tag, instance });
    });
    return () => {
      alive = false;
    };
  }, [tag]);
  if (tag !== undefined && loaded?.tag === tag) return { instance: loaded.instance, locale: tag };
  return { instance: uiCatalogue, locale: formatterLocale() };
}

export function createTimelineLabels(instance: I18n): TimelineLabels {
  const render = (descriptor: MessageDescriptor): string => instance._(descriptor);
  const partName = (part: StoryPart): string => render(part === 'prologue' ? msg`Prologue` : part === 'epilogue' ? msg`Epilogue` : msg`Main story`);
  const modeName = (mode: string): string => {
    switch (mode) {
      case 'flashback':
        return render(msg`flashback`);
      case 'flash-forward':
        return render(msg`flash-forward`);
      case 'parallel':
        return render(msg`parallel strand`);
      case 'frame':
        return render(msg`frame`);
      case 'dream':
        return render(msg`dream`);
      case 'mythic':
        return render(msg`mythic`);
      case 'backstory':
        return render(msg`backstory`);
      case 'simultaneous':
        return render(msg`simultaneous`);
      case 'circular':
        return render(msg`circular`);
      case 'time-skip':
        return render(msg`time skip`);
      default:
        return render(msg`linear`);
    }
  };
  return {
    partName,
    modeName,
    modeTag: (mode) => (mode === 'backstory' ? render(msg`Backstory`) : undefined),
    lane: {
      all: render(msg`All scenes`),
      noPov: render(msg`No POV`),
      noCharacter: render(msg`No character`),
      noLocation: render(msg`Unplaced`),
      noThread: render(msg`No thread`),
      modeGroup: (group) => {
        switch (group) {
          case 'main':
            return render(msg`Main`);
          case 'parallel':
            return render(msg`Parallel strand`);
          case 'frame':
            return render(msg`Frame`);
          case 'dream':
            return render(msg`Dream & mythic`);
          case 'backstory':
            return render(msg`Backstory`);
          default:
            return group;
        }
      },
    },
    gapBreak: (days) => render(msg`${plural(days, { one: '+# day', other: '+# days' })}`),
    timeSkipBreak: render(msg`Time skip (declared)`),
    foldLabel: (part, span, anchor) => {
      const name = partName(part);
      if (span === undefined) return name;
      const rest =
        part !== 'prologue'
          ? render(msg`${span} later`)
          : anchor === undefined
            ? render(msg`${span} before the main story`)
            : render(msg`${span} before ${anchor}`);
      return `${name}${SEPARATOR}${rest}`;
    },
    foldAnnounce: (part, label) => {
      const rest = label.includes(SEPARATOR) ? label.slice(label.indexOf(SEPARATOR) + SEPARATOR.length) : label;
      const lower = partName(part).toLowerCase();
      return render(msg`Fold: ${lower}, ${rest}`);
    },
    afterHint: (dayLabel) => render(msg`after ${dayLabel}`),
    itemName: (p) => {
      const pieces: string[] = [];
      const title = `\u2018${p.title}\u2019`;
      const part = partName(p.part);
      if (p.part !== 'main') pieces.push(render(msg`${part}: ${title}`));
      else if (p.partOverride) pieces.push(render(msg`Main story: ${title}`));
      else pieces.push(title);
      const { dayLabel, endLabel, durationDays, openFindings } = p;
      if (dayLabel === undefined) pieces.push(render(msg`undated`));
      else {
        pieces.push(endLabel !== undefined ? render(msg`${dayLabel} to ${endLabel}`) : dayLabel);
        if (durationDays !== undefined && durationDays > 0) pieces.push(render(msg`${plural(durationDays, { one: '# day', other: '# days' })}`));
      }
      pieces.push(modeName(p.mode));
      const { povName } = p;
      if (povName !== undefined) pieces.push(render(msg`POV ${povName}`));
      if (p.folderTitle !== undefined) pieces.push(p.folderTitle);
      if (p.partNote) pieces.push(render(msg`dated inside the main story`));
      if (p.overlaps.length > 0) {
        const names = p.overlaps.map((name) => `\u2018${name}\u2019`).join(', ');
        pieces.push(render(msg`overlaps ${names}`));
      }
      if (openFindings > 0) pieces.push(render(msg`${plural(openFindings, { one: '# open finding', other: '# open findings' })}`));
      return pieces.join(', ');
    },
  };
}

/** The words of the day lens: the digits come from the lens's own locale, the words from the catalogue. */
export function createDayLensMessages(instance: I18n): DayLensMessages {
  const render = (descriptor: MessageDescriptor): string => instance._(descriptor);
  return {
    day: (n) => render(msg`Day ${n}`),
    week: (n) => render(msg`Week ${n}`),
    month: (n) => render(msg`Month ${n}`),
    year: (n) => render(msg`Year ${n}`),
    days: (n, count) => render(msg`${plural(count, { one: `${n} day`, other: `${n} days` })}`),
    months: (n, count) => render(msg`${plural(count, { one: `${n} month`, other: `${n} months` })}`),
    years: (n, count) => render(msg`${plural(count, { one: `${n} year`, other: `${n} years` })}`),
    about: (text) => render(msg`about ${text}`),
  };
}
