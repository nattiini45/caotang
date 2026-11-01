/**
 * One picture's details on the picture board (pictures.md §5): its caption, alt text, decorative flag and tags, where it is placed,
 * and the delete the registry will confirm. Every edit is an `asset.*` command, so each is undoable and logged.
 *
 * The caption, alt text and tags are the writer's own words: shown in the project's language and direction, and isolated where a
 * sentence carries them.
 */

import { isolate } from '@caotang/i18n';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { PICTURE_LIMITS, type AssetTarget } from '@caotang/pictures';
import { useId, useState, type ReactNode } from 'react';

import { isImeEnter } from '../app/keymap.js';
import type { ProjectSession } from '../app/session.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { useDebouncedText, useReport, useSession } from '../components/shared.js';

import { makeDocumentLevel, removePlacement, setPictureMeta, setPlacementNote, placePicture } from './picture-actions.js';
import {
  altOf,
  blockersOf,
  bytesText,
  nodeChoicesOf,
  parseTags,
  pixelsText,
  sourceLabelOf,
  usedInLines,
  withTags,
  type PictureEntry,
} from './picture-board-model.js';
import { usePictureImage } from './picture-hooks.js';
import { PlacementNote } from './PlacementNote.js';

export interface PictureDetailsProps {
  readonly session: ProjectSession;
  readonly entry: PictureEntry;
  readonly onClose: () => void;
  readonly onAskDelete: () => void;
  /** Shows the picture large, over the board. */
  readonly onEnlarge: (opener: HTMLElement | null) => void;
  /** The binder item chosen on a placement: the writer goes there. */
  readonly onOpenNode?: (nodeId: string) => void;
}

export function PictureDetails({ session, entry, onClose, onAskDelete, onEnlarge, onOpenNode }: PictureDetailsProps): ReactNode {
  useLingui();
  useSession(session);
  const report = useReport();
  const { record } = entry;
  const state = session.state;
  const contentLang = state.manifest.project.language;
  const image = usePictureImage(session, record, true, session.assetsVersion());
  const id = useId();
  const blockers = blockersOf(entry);
  const typedUses = entry.uses.filter((use) => use.kind !== 'link');
  const placements = entry.uses.filter((use) => use.kind === 'link');
  const [placeTarget, setPlaceTarget] = useState('');
  const [tagLine, setTagLine] = useState('');
  const [tagNote, setTagNote] = useState<string | null>(null);
  const size = pixelsText(record);

  const caption = useDebouncedText(record.caption ?? '', (text) =>
    setPictureMeta(session, report, record.id, { caption: text.trim() === '' ? null : text }),
  );
  const alt = useDebouncedText(record.alt ?? '', (text) => setPictureMeta(session, report, record.id, { alt: text.trim() === '' ? null : text }));

  const addTags = (): void => {
    const planned = withTags(record.tags, parseTags(tagLine));
    if (!planned.ok) {
      setTagNote(planned.reason);
      return;
    }
    setTagNote(null);
    if (planned.tags.length === (record.tags ?? []).length) {
      setTagLine('');
      return;
    }
    if (setPictureMeta(session, report, record.id, { tags: planned.tags })) setTagLine('');
  };

  const nodeChoices = nodeChoicesOf(state);
  const place = (): void => {
    if (placeTarget === '') return;
    const target: AssetTarget = placeTarget === 'project' ? { kind: 'project' } : { kind: 'node', nodeId: placeTarget };
    if (placePicture(session, report, record.id, target)) setPlaceTarget('');
  };
  const title = accessibleText(t`Details of ${{ title: isolate(entry.label) }}`);

  return (
    <aside className="pb-details" aria-label={title}>
      <header className="pb-details-head">
        <h3 className="pb-details-title" lang={contentLang} dir="auto">
          {entry.label}
        </h3>
        <button type="button" className="button is-quiet" onClick={onClose}>
          <Trans>Close details</Trans>
        </button>
      </header>

      <div className="pb-preview">
        {image.url !== null ? (
          <>
            <img src={image.url} alt={altOf(record)} />
            <button type="button" className="button is-quiet" onClick={(event) => onEnlarge(event.currentTarget)}>
              <Trans>View larger</Trans>
            </button>
          </>
        ) : null}
        {entry.missing || image.state === 'missing' ? (
          <p className="pb-missing" role="status">
            <Trans>The file of this picture is missing from the project. Its caption and placements are kept.</Trans>
          </p>
        ) : image.state === 'error' ? (
          <p className="pb-missing" role="status">
            <Trans>This picture could not be read.</Trans>
          </p>
        ) : image.state === 'loading' ? (
          <p className="muted" role="status">
            <Trans>Loading the picture…</Trans>
          </p>
        ) : null}
      </div>

      <div className="pb-field">
        <label className="field-label" htmlFor={`${id}-caption`}>
          <Trans>Caption</Trans>
        </label>
        <textarea
          id={`${id}-caption`}
          rows={2}
          lang={contentLang}
          dir="auto"
          maxLength={PICTURE_LIMITS.caption}
          value={caption.value}
          onChange={(event) => caption.change(event.target.value)}
          onBlur={caption.flush}
        />
      </div>
      <div className="pb-field">
        <label className="field-label" htmlFor={`${id}-alt`}>
          <Trans>Alt text</Trans>
        </label>
        <input
          id={`${id}-alt`}
          type="text"
          lang={contentLang}
          dir="auto"
          maxLength={PICTURE_LIMITS.alt}
          value={alt.value}
          onChange={(event) => alt.change(event.target.value)}
          onBlur={alt.flush}
        />
        <p className="field-help">
          <Trans>Alt text describes the picture for a reader who cannot see it. It is separate from the caption.</Trans>
        </p>
      </div>
      <label className="pb-check">
        <input
          type="checkbox"
          checked={record.decorative === true}
          onChange={(event) => setPictureMeta(session, report, record.id, { decorative: event.target.checked })}
        />
        <span>
          <Trans>Decorative: a reader who cannot see it misses nothing</Trans>
        </span>
      </label>

      <div className="pb-field">
        <span className="field-label" id={`${id}-tags`}>
          <Trans>Tags</Trans>
        </span>
        {(record.tags ?? []).length === 0 ? (
          <p className="field-help">
            <Trans>No tags yet.</Trans>
          </p>
        ) : (
          <ul className="keyword-list" aria-labelledby={`${id}-tags`}>
            {(record.tags ?? []).map((tag) => (
              <li key={tag} className="chip chip-keyword">
                <span lang={contentLang} dir="auto">
                  {tag}
                </span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={accessibleText(t({ message: `Remove the tag ${{ tag: isolate(tag) }}`, comment: "A button that removes one tag from a picture; the value is the tag text." }))}
                  onClick={() => {
                    const rest = (record.tags ?? []).filter((other) => other !== tag);
                    setPictureMeta(session, report, record.id, { tags: rest.length === 0 ? null : rest });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pb-inline">
          <input
            type="text"
            aria-label={t`Add tags, separated by commas`}
            placeholder={t`Add tags`}
            value={tagLine}
            lang={contentLang}
            dir="auto"
            onChange={(event) => setTagLine(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || isImeEnter(event.nativeEvent)) return;
              event.preventDefault();
              addTags();
            }}
          />
          <button type="button" className="button" disabled={parseTags(tagLine).length === 0} onClick={addTags}>
            <Trans>Add tags</Trans>
          </button>
        </div>
        {tagNote === null ? null : (
          <p className="field-note is-complaint" role="alert">
            {tagNote}
          </p>
        )}
      </div>

      <dl className="pb-facts">
        <dt>
          <Trans>Size on disk</Trans>
        </dt>
        <dd>{bytesText(record.bytes)}</dd>
        {size === undefined ? null : (
          <>
            <dt>
              <Trans>Pixels</Trans>
            </dt>
            <dd>{size}</dd>
          </>
        )}
        {record.workingCopy === undefined ? null : (
          <>
            <dt>
              <Trans>Working copy</Trans>
            </dt>
            <dd>
              {t({ message: `The original was ${{ width: record.workingCopy.fromWidth }} × ${{ height: record.workingCopy.fromHeight }} px and ${{ size: bytesText(record.workingCopy.fromBytes) }}.`, comment: "Sizes of the original file before it was stored as a working copy; width and height are pixel counts, size is a formatted byte count." })}
            </dd>
          </>
        )}
        {record.source === undefined ? null : (
          <>
            <dt>
              <Trans>Source</Trans>
            </dt>
            <dd>
              {sourceLabelOf(record.source.kind)}
              {record.source.label === undefined ? null : (
                <>
                  {': '}
                  <span lang={contentLang} dir="auto">
                    {record.source.label}
                  </span>
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      <section className="pb-section" aria-label={t`Used in`}>
        <h4 className="field-label">
          <Trans>Used in</Trans>
        </h4>
        {entry.uses.length === 0 ? (
          <p className="field-help">
            <Trans>Nothing uses this picture yet. Place it on a binder item, or use it as a cover or a shot’s picture.</Trans>
          </p>
        ) : (
          <ul className="pb-uses">
            {usedInLines(state, typedUses).map((line) => (
              <li key={line.key} lang={contentLang} dir="auto">
                {line.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pb-section" aria-label={t`Placements`}>
        <h4 className="field-label">
          <Trans>Placed on</Trans>
        </h4>
        {placements.length === 0 ? (
          <p className="field-help">
            <Trans>Not placed on the project or a binder item.</Trans>
          </p>
        ) : (
          <ul className="pb-placements">
            {placements.map((use) => {
              if (use.kind !== 'link') return null;
              const link = entry.links.find((candidate) => candidate.id === use.linkId);
              const line = usedInLines(state, [use])[0];
              const nodeId = (use.target as { nodeId?: unknown }).nodeId;
              const orphaned = use.target.kind === 'paragraph' && (use.target as { orphaned?: unknown }).orphaned === true;
              const quote = use.target.kind === 'paragraph' ? (use.target as { anchor?: { exact?: unknown } }).anchor?.exact : undefined;
              return (
                <li key={use.linkId} className="pb-placement">
                  <p lang={contentLang} dir="auto">
                    {line?.text}
                  </p>
                  {orphaned ? (
                    <p className="field-note">
                      <span className="badge is-warn">
                        <Trans>Lost its paragraph</Trans>
                      </span>{' '}
                      {typeof quote === 'string' ? <del lang={contentLang}>{quote}</del> : null}
                    </p>
                  ) : null}
                  {link === undefined ? null : (
                    <PlacementNote
                      key={`${link.id}-${link.note ?? ''}`}
                      initial={link.note ?? ''}
                      label={t`Note for this placement`}
                      onCommit={(text) => setPlacementNote(session, report, link.id, text.trim() === '' ? null : text)}
                    />
                  )}
                  <div className="pb-inline">
                    {typeof nodeId === 'string' && onOpenNode !== undefined ? (
                      <button type="button" className="button is-quiet" onClick={() => onOpenNode(nodeId)}>
                        <Trans>Go to it</Trans>
                      </button>
                    ) : null}
                    {orphaned ? (
                      <button type="button" className="button is-quiet" onClick={() => makeDocumentLevel(session, report, use.linkId, isolate(entry.label))}>
                        <Trans>Make document-level</Trans>
                      </button>
                    ) : null}
                    <button type="button" className="button is-quiet" onClick={() => removePlacement(session, report, use.linkId)}>
                      <Trans>Take it off</Trans>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="pb-inline">
          <select aria-label={t`Place this picture on`} value={placeTarget} onChange={(event) => setPlaceTarget(event.target.value)}>
            <option value="">{t`Place on…`}</option>
            <option value="project">{t`The project`}</option>
            {nodeChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {`${'\u00a0\u00a0'.repeat(choice.depth)}${choice.title}`}
              </option>
            ))}
          </select>
          <button type="button" className="button" disabled={placeTarget === ''} onClick={place}>
            <Trans>Place</Trans>
          </button>
        </div>
        <p className="field-help">
          <Trans>To attach a picture to one paragraph, select the paragraph’s text in its document, then use Attach to this paragraph in the Pictures section of the Inspector.</Trans>
        </p>
      </section>

      <section className="pb-section pb-danger" aria-label={t`Delete this picture`}>
        {blockers.length === 0 ? null : (
          <>
            <p className="field-note" role="status">
              <Trans>This picture is still used, so it cannot be deleted:</Trans>
            </p>
            <ul className="pb-uses">
              {usedInLines(state, blockers).map((line) => (
                <li key={line.key} lang={contentLang} dir="auto">
                  {line.text}
                </li>
              ))}
            </ul>
            <p className="field-help">
              <Trans>Take it off those uses first, then delete it.</Trans>
            </p>
          </>
        )}
        <button type="button" className="button is-danger is-quiet" disabled={blockers.length > 0} onClick={onAskDelete}>
          <Trans>Delete picture…</Trans>
        </button>
      </section>
    </aside>
  );
}
