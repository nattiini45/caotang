/**
 * The video prompt pack panel — video-prompt-pack.md §2 to §5. One storyboard folder's shots, written for one target
 * model: the prompt each shot would send, the rows the validator raised, and the three exports (JSON, Markdown, CSV).
 *
 * The panel writes nothing to the project. Each export is a file the writer downloads, and Caotang never calls a vendor:
 * generation happens in the writer's own tool, with the writer's own account (video-prompt-pack.md §1).
 */

import { accessibleText } from '../i18n/accessible-text.js';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useState, type ReactNode } from 'react';

import type { TreeNode } from '@caotang/store';

import { downloadBytes } from '../app/download.js';
import type { ProjectSession } from '../app/session.js';
import { useSession } from '../components/shared.js';
import type { PackArtifact } from './engines.js';
import { useAssetRecords } from './hooks.js';
import { PACK_ARTIFACTS, PACK_TEMPLATES, exportPackOf, packPreviewOf, type PackPreview, type PackShotRow, type PanelIssue } from './prompt-pack-model.js';
import { fieldKeyOf, type PromptFieldKey } from './prompt-edit-model.js';
import type { MediaPorts } from './ports.js';


/* lingui-set comment="The prompt pack panel. Interpolated values: label names a pack file; fileName is a file name; vendor is a video model's name; number is a shot number; seconds and the counts are numbers." */
export interface PromptPackPanelProps {
  readonly session: ProjectSession;
  /** The storyboard folder whose shots the pack covers. */
  readonly folder: TreeNode;
  readonly ports?: MediaPorts;
  /**
   * Follows a check's link: the shot, the field it names, and the vendor the check is about. The board opens that shot's editor
   * and focuses the field. Absent: the checks name their fields but link nowhere.
   */
  readonly onFix?: (shotId: string, key: PromptFieldKey, vendor?: string) => void;
}

export function PromptPackPanel({ session, folder, ports, onFix }: PromptPackPanelProps): ReactNode {
  useLingui();
  useSession(session);
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const assets = useAssetRecords(ports?.assets, session.assetsVersion());
  const [templateId, setTemplateId] = useState(PACK_TEMPLATES[0]?.id ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const preview = packPreviewOf(session.state, folder.id, templateId, assets);

  if (preview === null) {
    return <p className="muted"><Trans>No target model is selected, so there is no pack to show.</Trans></p>;
  }

  const exportArtifact = (artifact: PackArtifact): void => {
    const outcome = exportPackOf(session.state, folder.id, preview.template.id, artifact, assets);
    if (outcome === null) return;
    const label = PACK_ARTIFACTS.find((item) => item.artifact === artifact)?.label ?? 'pack';
    if (!outcome.ok) {
      const errors = outcome.issues.filter((issue) => issue.severity === 'error').length;
      setMessage(t`The ${label} was not written. ${plural(errors, { one: 'One row is an error', other: '# rows are errors' })}, and the fix is in the list below.`);
      return;
    }
    const mime = PACK_ARTIFACTS.find((item) => item.artifact === artifact)?.mime ?? 'text/plain';
    downloadBytes(new TextEncoder().encode(outcome.text), outcome.fileName, mime);
    // A record the pack could not read is left out of the file, and the file must say so, not only the checks list.
    const unread = preview.issues.filter((issue) => issue.code === 'unreadable-record' && issue.severity === 'warning').length;
    const fileName = outcome.fileName;
    const vendor = preview.template.displayName;
    const written = t`The ${label} is written as ${fileName}. Attach any listed reference files in ${vendor} yourself.`;
    const left =
      unread === 0
        ? ''
        : ` ${plural(unread, { one: 'One stored record could not be read, so it is not in the file.', other: '# stored records could not be read, so they are not in the file.' })} ${t`The checks list says which.`}`;
    setMessage(`${written}${left}`);
  };

  const total = preview.rows.length + preview.missing.length;
  const rowCount = preview.rows.length;
  const vendor = preview.template.displayName;
  const rowShotIds = new Set(preview.rows.map((row) => row.shotId));
  const panelIssues = preview.issues.filter((issue) => issue.shotId === undefined || !rowShotIds.has(issue.shotId));

  return (
    <div className="pp-panel">
      <div className="pp-controls">
        <label className="pp-target">
          <span><Trans>Target model</Trans></span>
          <select aria-label={t`Target model`} value={preview.template.id} onChange={(event) => setTemplateId(event.target.value)}>
            {PACK_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.displayName}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {t`${rowCount} of ${plural(total, { one: '# shot', other: '# shots' })} have a prompt for ${vendor}.`}
        </p>
      </div>

      {preview.template.provisional === undefined ? null : (
        <p className="field-note" role="note">
          {preview.template.provisional}
        </p>
      )}

      <div className="empty-actions pp-exports">
        {PACK_ARTIFACTS.map((item) => (
          <button
            key={item.artifact}
            type="button"
            className={`button${item.artifact === 'json' ? ' is-primary' : ''}`}
            disabled={!preview.canExport || preview.rows.length === 0}
            onClick={() => exportArtifact(item.artifact)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {preview.canExport ? null : (
        <p className="field-note" role="note">
          <Trans>Export is held while a row is an error, so no file is written from a prompt the vendor would refuse.</Trans>
        </p>
      )}
      {message === null ? null : (
        <p className="drop-note" role="status" aria-live="polite">
          {message}
        </p>
      )}

      {panelIssues.length === 0 ? null : (
        <section className="pp-checks" aria-label={t`Checks for this pack`}>
          <h3 className="field-label"><Trans>Checks</Trans></h3>
          <ul className="findings">
            {panelIssues.map((issue) => (
              <IssueRow key={`${issue.code}:${issue.field}:${issue.message}`} issue={issue} onFix={onFix} />
            ))}
          </ul>
        </section>
      )}

      {preview.rows.length === 0 ? (
        <p className="muted">
          {t`No shot in this storyboard has a prompt for ${vendor} yet. Write a shot's prompt in its fields on the board, then come back here to export.`}
        </p>
      ) : (
        <ol className="pp-shots" aria-label={accessibleText(t`Prompts for ${vendor}`)}>
          {preview.rows.map((row) => (
            <ShotPromptRow key={row.shotId} row={row} preview={preview} onFix={onFix} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ShotPromptRow({ row, preview, onFix }: { readonly row: PackShotRow; readonly preview: PackPreview; readonly onFix?: PromptPackPanelProps['onFix'] }): ReactNode {
  useLingui();
  const seconds = row.durationSec;
  const spec = [row.mode, seconds === null ? '' : t`${seconds} s`, row.aspect].filter((part) => part !== '').join(' · ');
  return (
    <li className="pp-shot" data-shot-id={row.shotId}>
      <header className="pp-shot-head">
        <span className="chip sb-number" aria-label={accessibleText(t`Shot number ${{ number: row.number }}`)}>
          {row.number}
        </span>
        <span className="sb-spec">{spec}</span>
        {row.bestTake ? <span className="badge"><Trans>Best take kept</Trans></span> : null}
      </header>
      <p className="pp-prompt">{row.prompt === '' ? t`The prompt is empty.` : row.prompt}</p>
      {row.negative === '' ? null : (
        <p className="pp-note">
          <span className="field-label"><Trans>Negative prompt</Trans></span> {row.negative}
        </p>
      )}
      {row.audio.length === 0 ? null : (
        <ul className="pp-audio" aria-label={t`Audio cues`}>
          {row.audio.map((cue) => (
            <li key={cue}>{cue}</li>
          ))}
        </ul>
      )}
      {row.references.length === 0 ? null : (
        <p className="pp-note">
          <span className="field-label"><Trans>Attach</Trans></span> {row.references.join(', ')}
        </p>
      )}
      {row.consistency.length === 0 ? null : (
        <ul className="pp-audio" aria-label={accessibleText(t`Consistency of shot ${{ number: row.number }}`)}>
          {row.consistency.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {row.issues.length === 0 ? null : (
        <ul className="findings">
          {row.issues.map((issue) => (
            <IssueRow key={`${issue.code}:${issue.field}:${issue.message}`} issue={issue} onFix={onFix} />
          ))}
        </ul>
      )}
      <details className="pp-mapped">
        <summary>{t`The fields ${{ vendor: preview.template.displayName }} receives`}</summary>
        <pre>{JSON.stringify(row.mapped, null, 2)}</pre>
      </details>
    </li>
  );
}

/**
 * One check. When the check names a field the board's editor shows, and the shot is known, the row links to that field on the board,
 * so the writer goes straight to what the message asks them to change.
 */
function IssueRow({ issue, onFix }: { readonly issue: PanelIssue; readonly onFix?: PromptPackPanelProps['onFix'] }): ReactNode {
  useLingui();
  const key = issue.field === undefined ? undefined : fieldKeyOf(issue.field);
  const shotId = issue.shotId;
  const link = onFix !== undefined && key !== undefined && shotId !== undefined;
  return (
    <li className={`pp-issue is-${issue.severity}`}>
      <span className={`badge ${issue.severity === 'error' ? 'is-error' : 'is-warn'}`}>{issue.severity === 'error' ? t`Error` : t`Warning`}</span> {issue.message}
      {link ? (
        <>
          {' '}
          <button type="button" className="button is-quiet" onClick={() => onFix(shotId, key, issue.vendor)}>
            <Trans>Fix on the board</Trans>
          </button>
        </>
      ) : null}
    </li>
  );
}
