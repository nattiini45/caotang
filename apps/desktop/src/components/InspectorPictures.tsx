/**
 * The Inspector's picture strip (pictures.md §5): the pictures placed on the selected binder item, with a note on each placement, the
 * choice of which one is the item's card picture, and the ways to add one: link a picture the project holds, or import new ones onto
 * the item. Each change is an `asset.*` command, so it is undoable and logged. "Open on the board" shows the picture's details in the
 * picture board.
 */

import { isolate } from '@caotang/i18n';
import { captureParagraphAnchor } from '@caotang/pictures';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { getBody, getRevision, type TreeNode } from '@caotang/store';
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { currentEditorCaret, useEditorCaret } from '../app/editor-selection.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { useAssetListing } from '../media/hooks.js';
import { PlacementNote } from '../media/PlacementNote.js';
import { lostParagraphsOf, repinBlockedText } from '../media/lost-paragraph-model.js';
import { makeDocumentLevel, placePicture, removePlacement, repinPicture, setPlacementNote } from '../media/picture-actions.js';
import { altOf, canAttachToParagraph, entriesOf, PICTURE_ACCEPT, type PictureEntry } from '../media/picture-board-model.js';
import { usePictureImage, usePictureImporter } from '../media/picture-hooks.js';
import '../media/pictures.css';

import { useReport, useSession } from './shared.js';

/* lingui-set comment="The Inspector's picture strip. Interpolated values: title is a picture's caption or file name, a writer's own text." */



export function InspectorPictures({
  session,
  node,
  onOpenPicture,
}: {
  readonly session: ProjectSession;
  readonly node: TreeNode;
  /** Shows the picture's details on the board. Absent: the button is not offered. */
  readonly onOpenPicture?: (assetId: string) => void;
}): ReactNode {
  useLingui();
  useSession(session);
  const report = useReport();
  const importer = usePictureImporter(session);
  const listing = useAssetListing(session.assets.artifactFs(), session.assetsVersion());
  const present = listing.listing === 'listed' ? new Set(listing.records.keys()) : null;
  const entries = entriesOf(session.state, present);
  const contentLang = session.state.manifest.project.language;
  const [pick, setPick] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const id = useId();

  const placed = entries.filter((entry) => entry.nodeIds.includes(node.id));
  const candidates = entries.filter((entry) => !entry.nodeIds.includes(node.id));
  const target = { kind: 'node', nodeId: node.id } as const;
  // The caret the editor published (editor-selection.ts). An anchor's offsets are the body projection's, so they only mean
  // something while the store holds the text the caret is in — hence `dirty`, and the trust of the store's own body below.
  const caret = useEditorCaret();
  const canAttach = canAttachToParagraph(caret, node);
  const lost = lostParagraphsOf(session.state.manifest.assetLinks ?? [], node.id);
  const repinBlocked = repinBlockedText(caret, node);

  const attach = (): void => {
    if (caret === null || pick === '') return;
    const body = getBody(session.state, node.id);
    const anchor = captureParagraphAnchor(body, caret.from, getRevision(session.state, node.id));
    if (anchor === undefined) {
      report({ text: t`There is no paragraph to attach the picture to here.`, tone: 'error' });
      return;
    }
    // A paragraph placement is an ordinary link with a `paragraph` target (pictures.md §2.4), so it is one `asset.link` and
    // one undo. The anchor is captured against the stored body; the next write maps it like any other.
    if (placePicture(session, report, pick, { kind: 'paragraph', nodeId: node.id, anchor })) setPick('');
  };

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) void importer.importFiles(files, { links: [target] });
  };

  return (
    <section className="inspector-section pi-strip" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="field-label">
        <Trans>Pictures</Trans>
      </h3>
      {placed.length === 0 ? (
        <p className="field-help">
          <Trans>No pictures are placed on this item.</Trans>
        </p>
      ) : (
        <ul className="pi-list">
          {placed.map((entry) => (
            <Placed key={entry.id} session={session} entry={entry} nodeId={node.id} lang={contentLang} onOpenPicture={onOpenPicture} />
          ))}
        </ul>
      )}
      {lost.length === 0 ? null : (
        <section className="pi-lost" aria-labelledby={`${id}-lost`} data-testid="lost-paragraphs">
          <h4 id={`${id}-lost`} className="field-label">
            <Trans>Lost their paragraph</Trans>
          </h4>
          <p className="field-help">
            <Trans>The paragraph these pictures were attached to is gone. They stay here until you choose what to do with them.</Trans>
          </p>
          <ul className="pi-list">
            {lost.map((item) => {
              const label = entries.find((entry) => entry.id === item.assetId)?.label ?? item.assetId;
              return (
                <li key={item.linkId} className="pi-item">
                  <div className="pi-body">
                    <p className="pi-name" lang={contentLang} dir="auto" title={label}>
                      {label}
                    </p>
                    {item.quote === null ? null : (
                      <p className="field-note">
                        <del lang={contentLang} dir="auto">
                          {item.quote}
                        </del>
                      </p>
                    )}
                    <div className="pi-actions">
                      <button
                        type="button"
                        className="button is-quiet"
                        disabled={repinBlocked !== null}
                        aria-describedby={`${id}-repin-help`}
                        aria-label={accessibleText(t`Re-pin ${{ title: isolate(label) }} to the selected paragraph`)}
                        // The selection is read as the writer clicks, not as this list last rendered.
                        onClick={() => repinPicture(session, report, item.linkId, isolate(label), currentEditorCaret(), node)}
                      >
                        <Trans>Re-pin</Trans>
                      </button>
                      <button
                        type="button"
                        className="button is-quiet"
                        aria-label={accessibleText(t`Make ${{ title: isolate(label) }} document-level`)}
                        onClick={() => makeDocumentLevel(session, report, item.linkId, isolate(label))}
                      >
                        <Trans>Make document-level</Trans>
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="field-help" id={`${id}-repin-help`}>
            {repinBlocked ?? <Trans>Re-pin attaches the picture to the paragraph the selected text starts in.</Trans>}
          </p>
        </section>
      )}
      <div className="pb-inline">
        <select aria-label={t`Link a picture the project holds`} value={pick} lang={contentLang} onChange={(event) => setPick(event.target.value)} disabled={candidates.length === 0}>
          <option value="">{candidates.length === 0 ? t`No other pictures` : t`Link a picture…`}</option>
          {candidates.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={pick === ''}
          onClick={() => {
            if (placePicture(session, report, pick, target)) setPick('');
          }}
        >
          <Trans>Link</Trans>
        </button>
      </div>
      <div className="pb-inline">
        <input ref={fileInput} type="file" accept={PICTURE_ACCEPT} multiple hidden onChange={choose} data-testid="inspector-pictures-input" />
        <button type="button" className="button is-quiet" disabled={importer.busy} onClick={() => fileInput.current?.click()}>
          <Trans>Import pictures here…</Trans>
        </button>
      </div>
      <div className="pb-inline">
        <button type="button" className="button is-quiet" disabled={pick === '' || !canAttach} onClick={attach}>
          <Trans>Attach to this paragraph</Trans>
        </button>
      </div>
      <p className="field-help">
        {canAttach ? (
          <Trans>The picture attaches to the paragraph the selected text starts in.</Trans>
        ) : caret !== null && caret.docId === node.id && caret.dirty ? (
          <Trans>Attaching waits for the text to be saved.</Trans>
        ) : (
          <Trans>Select text in this document to attach a picture to its paragraph.</Trans>
        )}
      </p>
      {importer.dialog}
    </section>
  );
}

function Placed({
  session,
  entry,
  nodeId,
  lang,
  onOpenPicture,
}: {
  readonly session: ProjectSession;
  readonly entry: PictureEntry;
  readonly nodeId: string;
  readonly lang: string | undefined;
  readonly onOpenPicture: ((assetId: string) => void) | undefined;
}): ReactNode {
  const report = useReport();
  const image = usePictureImage(session, entry.record, true, session.assetsVersion());
  const links = entry.links.filter((link) => link.target.kind === 'node' && (link.target as { nodeId?: unknown }).nodeId === nodeId);
  const missing = entry.missing || image.state === 'missing';
  return (
    <>
      {links.map((link) => {
        const card = link.role === 'card';
        return (
          <li key={link.id} className="pi-item">
            <span className="pi-thumb">
              {image.url !== null ? (
                <img src={image.url} alt={altOf(entry.record)} />
              ) : missing ? (
                <Trans>File missing</Trans>
              ) : image.state === 'error' ? (
                <Trans>Unreadable</Trans>
              ) : (
                <Trans>Loading…</Trans>
              )}
            </span>
            <div className="pi-body">
              <p className="pi-name" lang={lang} dir="auto" title={entry.label}>
                {entry.label}
              </p>
              {card ? (
                <p className="pb-chips">
                  <span className="badge">
                    <Trans>Card picture</Trans>
                  </span>
                </p>
              ) : null}
              <PlacementNote
                key={`${link.id}-${link.note ?? ''}`}
                initial={link.note ?? ''}
                label={accessibleText(t`Note for ${{ title: isolate(entry.label) }} on this item`)}
                onCommit={(text) => setPlacementNote(session, report, link.id, text.trim() === '' ? null : text)}
              />
              <div className="pi-actions">
                {card ? null : (
                  <button
                    type="button"
                    className="button is-quiet"
                    aria-label={accessibleText(t`Make ${{ title: isolate(entry.label) }} the card picture`)}
                    onClick={() => placePicture(session, report, entry.id, { kind: 'node', nodeId }, true)}
                  >
                    <Trans>Make card picture</Trans>
                  </button>
                )}
                {onOpenPicture === undefined ? null : (
                  <button
                    type="button"
                    className="button is-quiet"
                    aria-label={accessibleText(t`Open ${{ title: isolate(entry.label) }} on the board`)}
                    onClick={() => onOpenPicture(entry.id)}
                  >
                    <Trans>Open on the board</Trans>
                  </button>
                )}
                <button
                  type="button"
                  className="button is-quiet"
                  aria-label={accessibleText(t`Take ${{ title: isolate(entry.label) }} off this item`)}
                  onClick={() => removePlacement(session, report, link.id)}
                >
                  <Trans>Take it off</Trans>
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </>
  );
}
