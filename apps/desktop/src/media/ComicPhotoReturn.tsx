/**
 * The review of a numbered photo return — comics.md §3.4. The photographs landed by their file-name number as one
 * `asset.importBatch` and each is the page's source (an `asset` link of role `source` on the page node); this panel is
 * where the writer sees the proposed panel crops over the source photograph and confirms or adjusts them before any
 * panel claims art. Until a page's crops are placed, its panels stay placeholders: an attached photograph is a source,
 * not placed panel art.
 *
 * The page value each placement writes against is the one the review read when it opened (`expect`), so a page that
 * changed since — a drag on the sheet, an agent's edit — is refused, and the writer is offered the current page
 * instead of the change being overwritten.
 */

/* lingui-set comment="The review of returned photographs. Interpolated values: number and count are page and panel numbers; counts are numbers grouped for the formatter locale." */

import { t, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { clampUnitRect, loadComicPage, proposedPanelCrop, type ComicPage, type Rect } from '@caotang/comic';
import type { ReadAssetRecord } from '@caotang/pictures';
import { nodeById, type TreeNode } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import { useSession } from '../components/shared.js';
import { usePictureImage } from './picture-hooks.js';

/** One photograph of the batch: the page it landed on, and the picture record it is stored as. */
export interface PhotoReturnEntry {
  readonly pageId: string;
  readonly pageNumber: number;
  readonly assetId: string;
  readonly name: string;
  readonly label: string;
}

/** The review's state: the batch, the page values it read, and the crop proposed or adjusted for each panel. */
export interface PhotoReview {
  readonly entries: readonly PhotoReturnEntry[];
  /** pageId → the stored page value the review read when it opened. */
  readonly expects: Readonly<Record<string, unknown>>;
  /** pageId → panelId → the crop in the photograph's own 0..1 space. */
  readonly crops: Readonly<Record<string, Readonly<Record<string, Rect>>>>;
  /** The pages whose crops were written to the page. */
  readonly placed: readonly string[];
  /** The pages the writer left alone: no panel on them claimed art. */
  readonly skipped: readonly string[];
  /** pageId → the refusal a placement met, when the page changed since the review opened. */
  readonly stale: Readonly<Record<string, string>>;
}

/** The review a batch opens with: the page values read now, and each panel's proposed crop over its photograph. */
export function emptyReview(entries: readonly PhotoReturnEntry[], tree: readonly TreeNode[]): PhotoReview {
  const expects: Record<string, unknown> = {};
  const crops: Record<string, Record<string, Rect>> = {};
  for (const entry of entries) {
    const node = tree.find((candidate) => candidate.id === entry.pageId);
    expects[entry.pageId] = node?.comicPage ?? null;
    const page = loadComicPage(node?.comicPage).value;
    const panelCrops: Record<string, Rect> = {};
    for (const panel of page.panels) panelCrops[panel.id] = proposedPanelCrop(panel.rect, page.size);
    crops[entry.pageId] = panelCrops;
  }
  return { entries, expects, crops, placed: [], skipped: [], stale: {} };
}

export interface ComicPhotoReturnProps {
  readonly session: ProjectSession;
  readonly review: PhotoReview;
  readonly onReview: (next: PhotoReview) => void;
  readonly onClose: () => void;
  /** Writes one page against the expect the review holds; `null` when it was placed, else the refusal's words. */
  readonly commitPage: (pageId: string, next: ComicPage, expect: unknown) => string | null;
}

/** One key press moves or resizes a crop by this share of the photograph. */
const CROP_KEY_STEP = 0.01;

const CROP_ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

/**
 * The photograph's width over its height: the size the browser reads from the picture itself (so an orientation tag is
 * honoured), else the record's stored size, else square. The sheet is drawn at this ratio so the photograph is never stretched.
 */
function usePhotoAspect(record: ReadAssetRecord | undefined, url: string | null): number {
  const [natural, setNatural] = useState<{ readonly url: string; readonly aspect: number } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    const probe = new Image();
    probe.onload = () => {
      if (live && probe.naturalWidth > 0 && probe.naturalHeight > 0) setNatural({ url, aspect: probe.naturalWidth / probe.naturalHeight });
    };
    probe.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  if (natural !== null && natural.url === url) return natural.aspect;
  const width = record?.width;
  const height = record?.height;
  return width !== undefined && height !== undefined && width > 0 && height > 0 ? width / height : 1;
}

interface CropDrag {
  readonly pageId: string;
  readonly panelId: string;
  readonly start: readonly [number, number];
  readonly orig: Rect;
  readonly current: Rect;
  readonly resize: boolean;
}

/** The label a picture goes by: its caption, else the file name the writer chose, else the file in `assets/`. */
export function pictureLabelOf(record: ReadAssetRecord | undefined): string {
  return record?.caption ?? record?.source?.label ?? record?.file ?? '';
}

export function ComicPhotoReturn({ session, review, onReview, onClose, commitPage }: ComicPhotoReturnProps): ReactNode {
  useLingui();
  useSession(session);
  const [shown, setShown] = useState<string | undefined>(review.entries[0]?.pageId);
  const [drag, setDrag] = useState<CropDrag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const state = session.state;

  const entry = review.entries.find((candidate) => candidate.pageId === shown) ?? review.entries[0];
  const pageNode = entry === undefined ? undefined : nodeById(state, entry.pageId);
  const page = loadComicPage(pageNode?.comicPage).value;
  const record = (state.manifest.assets ?? []).find((candidate) => candidate.id === entry?.assetId);
  const image = usePictureImage(session, record, entry !== undefined, session.assetsVersion());
  const aspect = usePhotoAspect(record, image.url);
  const sheetWidth = 100 * aspect;
  const crops = (entry === undefined ? undefined : review.crops[entry.pageId]) ?? {};
  const panelsOnPage = page.panels.length;

  const setCrop = (pageId: string, panelId: string, crop: Rect): void => {
    onReview({ ...review, crops: { ...review.crops, [pageId]: { ...review.crops[pageId], [panelId]: crop } } });
  };

  /** Places the reviewed crops on one page: every panel names the source photograph with its crop. */
  const place = (pageId: string): void => {
    const node = nodeById(state, pageId);
    const batchEntry = review.entries.find((candidate) => candidate.pageId === pageId);
    if (node === undefined || batchEntry === undefined) return;
    const current = loadComicPage(node.comicPage).value;
    const panelCrops = review.crops[pageId] ?? {};
    const next: ComicPage = {
      ...current,
      panels: current.panels.map((panel) => {
        const crop = panelCrops[panel.id];
        return crop === undefined ? panel : { ...panel, assetId: batchEntry.assetId, crop: clampUnitRect([...crop]) };
      }),
    };
    const refusal = commitPage(pageId, next, review.expects[pageId] ?? null);
    if (refusal === null) {
      const stale = { ...review.stale };
      delete stale[pageId];
      onReview({ ...review, placed: [...review.placed, pageId], stale });
    } else {
      onReview({ ...review, stale: { ...review.stale, [pageId]: refusal } });
    }
  };

  /** Reads a page again after a refusal, so its crops can be placed against what it holds now. */
  const readAgain = (pageId: string): void => {
    const node = nodeById(state, pageId);
    const stale = { ...review.stale };
    delete stale[pageId];
    onReview({ ...review, expects: { ...review.expects, [pageId]: node?.comicPage ?? null }, stale });
  };

  const toPhoto = (event: { clientX: number; clientY: number }): readonly [number, number] => {
    const svg = svgRef.current;
    if (svg === null) return [0, 0];
    const box = svg.getBoundingClientRect();
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
  };

  /** The arrow keys' way to move a crop, and with Shift to resize it from its corner; the result is clamped as a drag's is. */
  const onCropKey = (event: React.KeyboardEvent, panelId: string): void => {
    if (entry === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!CROP_ARROWS.includes(event.key as (typeof CROP_ARROWS)[number])) return;
    const crop = crops[panelId];
    if (crop === undefined) return;
    event.preventDefault();
    const dx = event.key === 'ArrowLeft' ? -CROP_KEY_STEP : event.key === 'ArrowRight' ? CROP_KEY_STEP : 0;
    const dy = event.key === 'ArrowUp' ? -CROP_KEY_STEP : event.key === 'ArrowDown' ? CROP_KEY_STEP : 0;
    setCrop(entry.pageId, panelId, event.shiftKey ? clampUnitRect([crop[0], crop[1], crop[2] + dx, crop[3] + dy]) : clampUnitRect([crop[0] + dx, crop[1] + dy, crop[2], crop[3]]));
  };

  const onCropPointerDown = (event: React.PointerEvent, panelId: string, resize: boolean): void => {
    const crop = crops[panelId];
    if (crop === undefined || entry === undefined) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setDrag({ pageId: entry.pageId, panelId, start: toPhoto(event), orig: crop, current: crop, resize });
  };

  const onCropPointerMove = (event: React.PointerEvent): void => {
    if (drag === null) return;
    const at = toPhoto(event);
    const dx = at[0] - drag.start[0];
    const dy = at[1] - drag.start[1];
    const next = drag.resize
      ? clampUnitRect([drag.orig[0], drag.orig[1], drag.orig[2] + dx, drag.orig[3] + dy])
      : clampUnitRect([drag.orig[0] + dx, drag.orig[1] + dy, drag.orig[2], drag.orig[3]]);
    setDrag({ ...drag, current: next });
  };

  const onCropPointerUp = (): void => {
    if (drag === null) return;
    setCrop(drag.pageId, drag.panelId, drag.current);
    setDrag(null);
  };

  const placedCount = review.placed.length;
  const skippedCount = review.skipped.length;
  const total = review.entries.length;

  return (
    <aside className="comic-review" aria-label={t`Review the returned photographs`}>
      <header className="comic-review-head">
        <h3>{t`Returned photographs`}</h3>
        <button type="button" className="button is-quiet" onClick={onClose}>
          <Trans>Close</Trans>
        </button>
      </header>
      <p className="muted">
        <Trans>
          Each photograph is attached to its page as the source, by its file name. The frames below are the proposed panel crops over the photograph — adjust them, then place them. Until a page's crops are placed, its panels stay empty placeholders.
        </Trans>
      </p>
      {review.entries.length === 0 ? null : (
        <ul className="comic-review-list" aria-label={t`Photographs in this batch`}>
          {review.entries.map((candidate) => {
            const stale = review.stale[candidate.pageId];
            const done = review.placed.includes(candidate.pageId);
            const left = review.skipped.includes(candidate.pageId);
            return (
              <li key={candidate.pageId}>
                <button type="button" className={`button is-quiet${shown === candidate.pageId ? ' is-on' : ''}`} onClick={() => setShown(candidate.pageId)}>
                  {t`Page ${{ number: candidate.pageNumber }}`}
                  {': '}
                  <span dir="auto">{candidate.label}</span>
                </button>
                {done ? <span className="badge">{t`Crops placed`}</span> : null}
                {left ? <span className="badge">{t`Skipped`}</span> : null}
                {stale === undefined ? null : <span className="badge is-warn">{t`Changed since the review opened`}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {entry === undefined ? null : (
        <section className="comic-review-page" aria-label={t`Page ${{ number: entry.pageNumber }}`}>
          <p className="muted">
            {t`${plural(panelsOnPage, { one: '# panel', other: '# panels' })} on page ${{ number: entry.pageNumber }}, each showing its crop of the source photograph.`}
          </p>
          <svg
            ref={svgRef}
            className="comic-review-sheet"
            viewBox={`0 0 ${sheetWidth} 100`}
            style={{ aspectRatio: `${sheetWidth} / 100` }}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={t`The photograph of page ${{ number: entry.pageNumber }} with the proposed panel crops`}
          >
            {image.url === null ? <rect x={0} y={0} width={sheetWidth} height={100} className="comic-review-missing" /> : null}
            {image.url === null ? null : <image href={image.url} x={0} y={0} width={sheetWidth} height={100} preserveAspectRatio="xMidYMid meet" />}
            {image.url === null ? (
              <text x={sheetWidth / 2} y={50} textAnchor="middle" className="comic-review-missing-text">
                {t`The photograph's file could not be read`}
              </text>
            ) : null}
            {page.panels.map((panel, index) => {
              const crop = drag !== null && drag.panelId === panel.id ? drag.current : (crops[panel.id] ?? proposedPanelCrop(panel.rect, page.size));
              return (
                <g key={panel.id}>
                  <rect
                    className="comic-crop"
                    x={crop[0] * sheetWidth}
                    y={crop[1] * 100}
                    width={Math.max(crop[2] * sheetWidth, 0.5)}
                    height={Math.max(crop[3] * 100, 0.5)}
                    tabIndex={0}
                    role="button"
                    aria-label={t`Crop of panel ${{ number: index + 1 }}: drag to move it, the corner handle resizes it; the arrow keys move it and Shift with the arrow keys resizes it`}
                    onPointerDown={(event) => onCropPointerDown(event, panel.id, false)}
                    onPointerMove={onCropPointerMove}
                    onPointerUp={onCropPointerUp}
                    onKeyDown={(event) => onCropKey(event, panel.id)}
                  />
                  <rect
                    className="comic-crop-handle"
                    x={crop[0] * sheetWidth + crop[2] * sheetWidth - 2}
                    y={crop[1] * 100 + crop[3] * 100 - 2}
                    width={2}
                    height={2}
                    tabIndex={-1}
                    aria-hidden="true"
                    onPointerDown={(event) => onCropPointerDown(event, panel.id, true)}
                    onPointerMove={onCropPointerMove}
                    onPointerUp={onCropPointerUp}
                  />
                  <text className="comic-crop-number" x={crop[0] * sheetWidth + 1.5} y={crop[1] * 100 + 4}>
                    {index + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="comic-review-actions">
            <button
              type="button"
              className="button"
              disabled={review.placed.includes(entry.pageId) || review.skipped.includes(entry.pageId)}
              onClick={() => {
                place(entry.pageId);
              }}
            >
              {t`Place the crops on page ${{ number: entry.pageNumber }}`}
            </button>
            {review.stale[entry.pageId] === undefined ? null : (
              <button type="button" className="button is-quiet" onClick={() => readAgain(entry.pageId)}>
                <Trans>Read the page again and place</Trans>
              </button>
            )}
            <button
              type="button"
              className="button is-quiet"
              disabled={review.placed.includes(entry.pageId) || review.skipped.includes(entry.pageId)}
              onClick={() => onReview({ ...review, skipped: [...review.skipped, entry.pageId] })}
            >
              <Trans>Skip this page</Trans>
            </button>
          </div>
          {review.stale[entry.pageId] === undefined ? null : (
            <p className="comic-notice" role="alert">
              {review.stale[entry.pageId]}
            </p>
          )}
        </section>
      )}
      <p className="muted">
        {t`${plural(placedCount, { one: '# page placed', other: '# pages placed' })} of ${plural(total, { one: '# photograph', other: '# photographs' })}.`}
        {skippedCount === 0 ? null : <> {t`${plural(skippedCount, { one: '# page skipped', other: '# pages skipped' })}.`}</>}
      </p>
    </aside>
  );
}
