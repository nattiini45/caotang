import { beforeEach, describe, expect, it } from 'vitest';

import { calendarExamples } from '../src/components/timeline/calendar-examples.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { draftOf, previewOf, savePlan, textOfCalendar } from '../src/app/calendar-editor-model.js';

beforeEach(activateEnglish);

describe('the calendar editor model', () => {
  it('reads every example the editor offers as a usable calendar', () => {
    for (const example of calendarExamples()) {
      const draft = draftOf(textOfCalendar(example.definition));
      expect(draft.kind, example.key).toBe('valid');
    }
  });

  it('tells an empty box, text that is not JSON, JSON that is not a calendar and an oversize box apart', () => {
    expect(draftOf('  \n').kind).toBe('empty');
    expect(draftOf('{ "version": ').kind).toBe('syntax');
    const invalid = draftOf('{"version":1,"id":"x","name":"X","yearZero":"include","epoch":{"year":1,"month":1,"day":1},"months":[]}');
    expect(invalid.kind).toBe('invalid');
    if (invalid.kind === 'invalid') expect(invalid.problems.length).toBeGreaterThan(0);
    expect(draftOf(' '.repeat(40_000) + '{}').kind).toBe('too-long');
  });

  it('previews day 0 through the calendar it would save', () => {
    const [gregorian] = calendarExamples();
    const draft = draftOf(textOfCalendar(gregorian?.definition));
    if (draft.kind !== 'valid') throw new Error('the example is not usable');
    const preview = previewOf(draft.definition, { locale: 'en' });
    expect(preview[0]).toEqual({ day: 0, label: '1 January, 2,000' });
    expect(preview[3]?.label).toBe('31 December, 2,000');
  });

  it('saves the calendar with the choice of it, keeps a usable one beside the day lens, and otherwise sends only the choice', () => {
    const [gregorian] = calendarExamples();
    const valid = draftOf(textOfCalendar(gregorian?.definition));
    expect(savePlan('calendar', valid)).toMatchObject({ lens: 'calendar', calendar: { id: 'gregorian' } });
    expect(savePlan('calendar', { kind: 'empty' })).toBeNull();
    expect(savePlan('calendar', { kind: 'syntax', detail: 'x' })).toBeNull();
    expect(savePlan('day', { kind: 'syntax', detail: 'x' })).toEqual({ lens: 'day' });
    expect(savePlan('day', { kind: 'empty' })).toEqual({ lens: 'day' });
    expect(savePlan('day', valid)).toMatchObject({ lens: 'day', calendar: { id: 'gregorian' } });
  });
});
