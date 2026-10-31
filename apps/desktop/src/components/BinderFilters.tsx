/**
 * The binder's filter bar (binder-filters §5): a live text field, the status, label, keyword, word-count and date-window
 * criteria, the saved filters to apply, and the "Save current" form. The binder shows exactly what the bar matches, and the
 * bar always says how to get back to the whole binder. Nothing here changes the project: a filter is a view over the tree.
 */

import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { isolate } from '@caotang/i18n';
import type { SavedFilter } from '@caotang/furniture';

import { filterResultFor, furnitureFor, isEmptyDraft, tagsOf } from '../app/furniture-store.js';
import type { ProjectSession } from '../app/session.js';
import { useComposingEnter, useSession } from './shared.js';


/* lingui-set comment="The binder filter bar. Interpolated values: filterName is the saved filter's name, written by the writer; the count is a number." */
/** binder-filters §5: the text field is debounced, so a filter follows the writer's typing without a re-render per key. */
export const FILTER_TEXT_DEBOUNCE_MS = 150;

/** The id of the filter text field. `Ctrl+Alt+F` focuses it (see `focusBinderFilter`). */
export const FILTER_TEXT_ID = 'binder-filter-text';

/**
 * Moves focus to the filter text field (binder-filters §5). It is a no-op when the binder rail is not showing, as in focus
 * mode, so the chord never moves focus somewhere the writer cannot see.
 */
export function focusBinderFilter(): boolean {
  const field = document.getElementById(FILTER_TEXT_ID);
  if (field === null) return false;
  field.focus();
  return true;
}

export function BinderFilterBar({ session }: { session: ProjectSession }): ReactNode {
  useLingui();
  useSession(session);
  const store = furnitureFor(session);
  const furniture = useSyncExternalStore(store.subscribe, store.snapshot);
  const draft = furniture.draft;
  const [text, setText] = useState(draft.text);
  const [known, setKnown] = useState(draft.text);
  const [naming, setNaming] = useState<{ readonly id: string | null; readonly name: string } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // The filter-naming form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving.
  const ime = useComposingEnter();

  // The text the writer typed reaches the draft after the debounce. A change from outside the field (a saved filter applied,
  // the bar cleared) brings the field along with it, so the field never shows text the binder is not filtering by. The
  // comparison is made while rendering, so the field agrees with the draft before the first paint that shows either.
  if (draft.text !== known) {
    setKnown(draft.text);
    setText(draft.text);
  }
  useEffect(() => {
    if (text === draft.text) return;
    const timer = setTimeout(() => store.setDraft({ text }), FILTER_TEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, draft.text, store]);

  const applied = furniture.applied;
  const matches = applied === null ? null : filterResultFor(session.state, applied.criteria, new Date()).matchCount;
  const filterName = isolate(applied?.name ?? '');
  const statuses = session.state.manifest.vocabulary.statuses;
  const labels = session.state.manifest.vocabulary.labels;
  const nothingSet = isEmptyDraft(draft);
  const allTags = tagsOf(draft.keywordsAll);
  const anyTags = tagsOf(draft.keywordsAny);
  // A saved filter may name a term the project has since removed. The select shows that id as a disabled option, so it is never blank
  // while the criteria still filter by it (binder-filters §5: the bar and the tree must agree).
  const unknownStatus = draft.statusId !== '' && !statuses.some((status) => status.id === draft.statusId);
  const unknownLabel = draft.labelId !== '' && !labels.some((label) => label.id === draft.labelId);

  const submitName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    if (naming === null) return;
    const outcome = store.saveFilter(naming.name.trim(), naming.id ?? undefined);
    if (!outcome.ok) {
      setNameError(outcome.errors.join(' '));
      return;
    }
    setNaming(null);
    setNameError(null);
  };

  return (
    <section className="binder-filters" aria-label={t`Filter the binder`} data-testid="binder-filters">
      <input
        id={FILTER_TEXT_ID}
        type="search"
        className="filter-text"
        aria-label={t`Filter the binder by text`}
        placeholder={t`Filter by title, synopsis or text`}
        maxLength={200}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="filter-fields">
        <select aria-label={t`Status filter`} value={draft.statusId} onChange={(event) => store.setDraft({ statusId: event.target.value })}>
          <option value=""><Trans>Any status</Trans></option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
          {unknownStatus ? (
            <option value={draft.statusId} disabled>
              <Trans>Unknown status</Trans>
            </option>
          ) : null}
        </select>
        <select aria-label={t`Label filter`} value={draft.labelId} onChange={(event) => store.setDraft({ labelId: event.target.value })}>
          <option value=""><Trans>Any label</Trans></option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
          {unknownLabel ? (
            <option value={draft.labelId} disabled>
              <Trans>Unknown label</Trans>
            </option>
          ) : null}
        </select>
        <input
          type="number"
          min={0}
          aria-label={t`Minimum words`}
          placeholder={t`Min words`}
          value={draft.minWords}
          onChange={(event) => store.setDraft({ minWords: event.target.value })}
        />
        <input
          type="number"
          min={0}
          aria-label={t`Maximum words`}
          placeholder={t`Max words`}
          value={draft.maxWords}
          onChange={(event) => store.setDraft({ maxWords: event.target.value })}
        />
      </div>

      <div className="filter-fields filter-keywords">
        <label className="filter-field">
          <span><Trans>Has all of these keywords</Trans></span>
          <input
            type="text"
            aria-label={t`Keywords, all of these`}
            placeholder={t`sea, grief`}
            maxLength={600}
            value={draft.keywordsAll}
            onChange={(event) => store.setDraft({ keywordsAll: event.target.value })}
          />
        </label>
        <label className="filter-field">
          <span><Trans>Has any of these keywords</Trans></span>
          <input
            type="text"
            aria-label={t`Keywords, any of these`}
            placeholder={t`sea, storm`}
            maxLength={600}
            value={draft.keywordsAny}
            onChange={(event) => store.setDraft({ keywordsAny: event.target.value })}
          />
        </label>
      </div>
      {allTags.length + anyTags.length > 0 ? (
        <p className="filter-chips" aria-label={t`Keyword criteria`}>
          {allTags.map((tag) => (
            <span key={`all-${tag}`} className="filter-chip" data-kind="all">
              {tag}
            </span>
          ))}
          {anyTags.map((tag) => (
            <span key={`any-${tag}`} className="filter-chip" data-kind="any">
              {tag}
            </span>
          ))}
        </p>
      ) : null}

      <div className="filter-fields filter-dates">
        <label className="filter-field">
          <span><Trans>Changed in the last</Trans></span>
          <span className="filter-days">
            <input
              type="number"
              min={1}
              placeholder={t`days`}
              value={draft.modifiedWithinDays}
              onChange={(event) => store.setDraft({ modifiedWithinDays: event.target.value })}
            />
            <Trans>days</Trans>
          </span>
        </label>
        <label className="filter-field">
          <span><Trans>Created in the last</Trans></span>
          <span className="filter-days">
            <input
              type="number"
              min={1}
              placeholder={t`days`}
              value={draft.createdWithinDays}
              onChange={(event) => store.setDraft({ createdWithinDays: event.target.value })}
            />
            <Trans>days</Trans>
          </span>
        </label>
      </div>

      <div className="filter-row">
        <select
          aria-label={t`Saved filters`}
          value={applied?.savedId ?? ''}
          onChange={(event) => {
            const saved = furniture.filters.find((filter) => filter.id === event.target.value);
            if (saved !== undefined) store.applySaved(saved);
            else store.clearFilter();
          }}
        >
          <option value="">{furniture.filters.length === 0 ? t`No saved filters yet` : t`Saved filters`}</option>
          {furniture.filters.map((filter) => (
            <option key={filter.id} value={filter.id}>
              {filter.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button is-quiet"
          disabled={nothingSet}
          onClick={() => setNaming({ id: applied?.savedId ?? null, name: applied?.name ?? '' })}
        >
          {applied?.savedId ? t`Update saved filter…` : t`Save current…`}
        </button>
        {nothingSet && applied === null ? null : (
          <button type="button" className="button is-quiet" aria-label={t`Clear the filter`} onClick={() => store.clearFilter()}>
            <Trans>Clear</Trans>
          </button>
        )}
      </div>

      {applied !== null && matches !== null ? (
        <p className="filter-status" role="status" data-testid="filter-status">
          {applied.name !== ''
            ? plural(matches, {
                one: `# scene matches “${filterName}”. Clear the filter to see the whole binder.`,
                other: `# scenes match “${filterName}”. Clear the filter to see the whole binder.`,
              })
            : plural(matches, {
                one: '# scene matches. Clear the filter to see the whole binder.',
                other: '# scenes match. Clear the filter to see the whole binder.',
              })}
        </p>
      ) : null}

      {naming !== null ? (
        <form className="filter-naming" aria-label={t`Name this filter`} onKeyDown={ime.noteKey} onSubmit={submitName}>
          <label>
            <span><Trans>Filter name</Trans></span>
            <input
              type="text"
              maxLength={60}
              autoFocus
              value={naming.name}
              onChange={(event) => setNaming({ id: naming.id, name: event.target.value })}
            />
          </label>
          <button type="submit" className="button is-primary">
            <Trans>Save filter</Trans>
          </button>
          <button type="button" className="button is-quiet" onClick={() => setNaming(null)}>
            <Trans>Cancel</Trans>
          </button>
          {nameError !== null ? (
            <p className="form-message is-error" role="alert">
              {nameError}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

/** The one saved filter a row names, for the footer's list: what it is called and what it matches. */
export function savedFilterMatches(session: ProjectSession, filter: SavedFilter): number {
  return filterResultFor(session.state, filter.criteria, new Date()).matchCount;
}
