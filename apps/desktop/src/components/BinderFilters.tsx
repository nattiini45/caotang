/**
 * The binder's filter bar (binder-filters §5): a live text field, the status, label, keyword, word-count and date-window
 * criteria, the saved filters to apply, and the "Save current" form. The binder shows exactly what the bar matches, and the
 * bar always says how to get back to the whole binder. Nothing here changes the project: a filter is a view over the tree.
 */

import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { SavedFilter } from '@caotang/furniture';

import { filterResultFor, furnitureFor, isEmptyDraft, tagsOf } from '../app/furniture-store.js';
import type { ProjectSession } from '../app/session.js';
import { useComposingEnter, useSession } from './shared.js';

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
    <section className="binder-filters" aria-label="Filter the binder" data-testid="binder-filters">
      <input
        id={FILTER_TEXT_ID}
        type="search"
        className="filter-text"
        aria-label="Filter the binder by text"
        placeholder="Filter by title, synopsis or text"
        maxLength={200}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="filter-fields">
        <select aria-label="Status filter" value={draft.statusId} onChange={(event) => store.setDraft({ statusId: event.target.value })}>
          <option value="">Any status</option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
          {unknownStatus ? (
            <option value={draft.statusId} disabled>
              Unknown status
            </option>
          ) : null}
        </select>
        <select aria-label="Label filter" value={draft.labelId} onChange={(event) => store.setDraft({ labelId: event.target.value })}>
          <option value="">Any label</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
          {unknownLabel ? (
            <option value={draft.labelId} disabled>
              Unknown label
            </option>
          ) : null}
        </select>
        <input
          type="number"
          min={0}
          aria-label="Minimum words"
          placeholder="Min words"
          value={draft.minWords}
          onChange={(event) => store.setDraft({ minWords: event.target.value })}
        />
        <input
          type="number"
          min={0}
          aria-label="Maximum words"
          placeholder="Max words"
          value={draft.maxWords}
          onChange={(event) => store.setDraft({ maxWords: event.target.value })}
        />
      </div>

      <div className="filter-fields filter-keywords">
        <label className="filter-field">
          <span>Has all of these keywords</span>
          <input
            type="text"
            aria-label="Keywords, all of these"
            placeholder="sea, grief"
            maxLength={600}
            value={draft.keywordsAll}
            onChange={(event) => store.setDraft({ keywordsAll: event.target.value })}
          />
        </label>
        <label className="filter-field">
          <span>Has any of these keywords</span>
          <input
            type="text"
            aria-label="Keywords, any of these"
            placeholder="sea, storm"
            maxLength={600}
            value={draft.keywordsAny}
            onChange={(event) => store.setDraft({ keywordsAny: event.target.value })}
          />
        </label>
      </div>
      {allTags.length + anyTags.length > 0 ? (
        <p className="filter-chips" aria-label="Keyword criteria">
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
          <span>Changed in the last</span>
          <span className="filter-days">
            <input
              type="number"
              min={1}
              placeholder="days"
              value={draft.modifiedWithinDays}
              onChange={(event) => store.setDraft({ modifiedWithinDays: event.target.value })}
            />
            days
          </span>
        </label>
        <label className="filter-field">
          <span>Created in the last</span>
          <span className="filter-days">
            <input
              type="number"
              min={1}
              placeholder="days"
              value={draft.createdWithinDays}
              onChange={(event) => store.setDraft({ createdWithinDays: event.target.value })}
            />
            days
          </span>
        </label>
      </div>

      <div className="filter-row">
        <select
          aria-label="Saved filters"
          value={applied?.savedId ?? ''}
          onChange={(event) => {
            const saved = furniture.filters.find((filter) => filter.id === event.target.value);
            if (saved !== undefined) store.applySaved(saved);
            else store.clearFilter();
          }}
        >
          <option value="">{furniture.filters.length === 0 ? 'No saved filters yet' : 'Saved filters'}</option>
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
          {applied?.savedId ? 'Update saved filter…' : 'Save current…'}
        </button>
        {nothingSet && applied === null ? null : (
          <button type="button" className="button is-quiet" aria-label="Clear the filter" onClick={() => store.clearFilter()}>
            Clear
          </button>
        )}
      </div>

      {applied !== null && matches !== null ? (
        <p className="filter-status" role="status" data-testid="filter-status">
          {matches === 1 ? '1 scene match' : `${matches} scenes match`}
          {applied.name !== '' ? ` “${applied.name}”` : ''}. Clear the filter to see the whole binder.
        </p>
      ) : null}

      {naming !== null ? (
        <form className="filter-naming" aria-label="Name this filter" onKeyDown={ime.noteKey} onSubmit={submitName}>
          <label>
            <span>Filter name</span>
            <input
              type="text"
              maxLength={60}
              autoFocus
              value={naming.name}
              onChange={(event) => setNaming({ id: naming.id, name: event.target.value })}
            />
          </label>
          <button type="submit" className="button is-primary">
            Save filter
          </button>
          <button type="button" className="button is-quiet" onClick={() => setNaming(null)}>
            Cancel
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
