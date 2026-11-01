/**
 * The in-shot prompt editor (video-prompt-pack.md §2–§3): one shot's prompt for one vendor, written in the shot's own fields. The
 * writer picks a target model and edits its prompt parts, audio cues, negative prompt, duration, aspect, references and best take.
 * Saving writes the record through `shot.setMeta` (prompt-edit-model.ts), so the other vendors' records stay as they were.
 *
 * The checks under the fields are the engine's rows for this shot, read from the saved record, so they say what the export would
 * say. Each row that names a field links to it. An unsaved edit is checked once it is saved.
 */

import { accessibleText } from '../i18n/accessible-text.js';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { useSession } from '../components/shared.js';
import { commitShotCommand } from './commit.js';
import {
  PACK_TEMPLATES,
  packPreviewOf,
  type PanelIssue,
} from './prompt-pack-model.js';
import {
  REFERENCE_TYPES,
  VIDEO_RESOLUTIONS,
  templateById,
  type AssetRecord,
  type VideoShotRef,
  type VideoVendorTemplate,
} from './engines.js';
import {
  clearPromptCommand,
  fieldIdOf,
  fieldKeyOf,
  promptEditCommand,
  recordOf,
  recordOfDraft,
  syncVendorDraft,
  vendorDraftOf,
  type PromptDraft,
  type PromptFieldKey,
  type ReferenceDraft,
  type VendorDraftState,
} from './prompt-edit-model.js';
import type { MediaPorts } from './ports.js';


/* lingui-set comment="The shot prompt editor. Interpolated values: vendor is a video model's name; duration is a number of seconds; number is the position of a reference." */
export interface ShotPromptEditorProps {
  readonly session: ProjectSession;
  readonly shotId: string;
  /** The storyboard folder the shot sits in, so its checks are the folder's pack for the chosen vendor. */
  readonly folderId: string;
  /** The project's images, by asset id, for the reference picker and the checks. */
  readonly assets: ReadonlyMap<string, AssetRecord>;
  readonly ports: MediaPorts | undefined;
  /** A field to bring into view, from a check's link on the Prompt pack tab. A new object each time the link is followed. */
  readonly focus: { readonly key: PromptFieldKey; readonly vendor?: string } | null;
}

/** The first target model's id, which the editor starts on. */
const FIRST_VENDOR = PACK_TEMPLATES[0]?.id ?? '';

export function ShotPromptEditor({ session, shotId, folderId, assets, ports, focus }: ShotPromptEditorProps): ReactNode {
  useSession(session);
  const [vendorId, setVendorId] = useState(() => focus?.vendor ?? FIRST_VENDOR);
  // The message lives here, above the vendor's editor: a save changes the stored record, which the editor is shown again from.
  const [message, setMessage] = useState<string | null>(null);
  // The text typed for each vendor, kept while another vendor is on screen (Media-1), so a switch of vendor loses none of it. It is held
  // here and not in the editor. ShotEditor is keyed on the shot, so a shot switch starts every vendor's text again, as the other fields do.
  const [held, setHeld] = useState<Readonly<Record<string, VendorDraftState>>>({});
  // The focus request already brought into view, so a save that re-renders the editor does not move the focus a second time.
  const appliedRef = useRef<unknown>(null);
  const template = templateById(vendorId);
  if (template === undefined) return null;
  const vendor = template.displayName;
  const record = recordOf(session.state, shotId, template.id);
  // A stored record that changed since the held text was taken (an undo, or an agent's apply to this shot) replaces that text with the
  // stored values, and the message says so when the writer had typed something. A save made here is taken in by `stored`, not here.
  const sync = syncVendorDraft(held[template.id], record);
  if (held[template.id] !== undefined && sync.state !== held[template.id]) {
    setHeld((previous) => ({ ...previous, [template.id]: sync.state }));
    if (sync.replaced) {
      setMessage(t`The saved prompt for ${vendor} changed, so the text you had typed for it was replaced by the saved prompt.`);
    }
  }
  const current = sync.state;
  const edit = (update: (draft: PromptDraft) => PromptDraft): void => {
    setHeld((previous) => {
      const base = previous[template.id] ?? current;
      return { ...previous, [template.id]: { ...base, draft: update(base.draft) } };
    });
  };
  // A save or a removal changed this vendor's stored record, so its text is taken from the record as it now stands.
  const stored = (next: VideoShotRef | undefined): void => {
    setHeld((previous) => ({ ...previous, [template.id]: vendorDraftOf(next) }));
  };
  return (
    <PromptRecordEditor
      key={template.id}
      session={session}
      shotId={shotId}
      folderId={folderId}
      assets={assets}
      ports={ports}
      focus={focus}
      appliedRef={appliedRef}
      template={template}
      record={record}
      draft={current.draft}
      onEdit={edit}
      onStored={stored}
      onVendor={(next) => {
        setMessage(null);
        setVendorId(next);
      }}
      message={message}
      onMessage={setMessage}
    />
  );
}

interface PromptRecordEditorProps {
  readonly session: ProjectSession;
  readonly shotId: string;
  readonly folderId: string;
  readonly assets: ReadonlyMap<string, AssetRecord>;
  readonly ports: MediaPorts | undefined;
  readonly focus: { readonly key: PromptFieldKey; readonly vendor?: string } | null;
  /** The last focus request the outer editor brought into view, which survives this editor's remounts. */
  readonly appliedRef: { current: unknown };
  readonly template: VideoVendorTemplate;
  readonly record: VideoShotRef | undefined;
  /** The text the writer has for this vendor, which the editor shows. */
  readonly draft: PromptDraft;
  /** Changes that text. The outer editor holds it, so it survives a switch of vendor. */
  readonly onEdit: (update: (draft: PromptDraft) => PromptDraft) => void;
  /** Takes the text from the stored record again, after this editor saved or removed the record. */
  readonly onStored: (record: VideoShotRef | undefined) => void;
  readonly onVendor: (vendorId: string) => void;
  readonly message: string | null;
  readonly onMessage: (message: string | null) => void;
}

function PromptRecordEditor({ session, shotId, folderId, assets, ports, focus, appliedRef, template, record, draft, onEdit, onStored, onVendor, message, onMessage }: PromptRecordEditorProps): ReactNode {
  useLingui();
  const vendor = template.displayName;
  const setMessage = onMessage;

  // A check's link brings its field into view: the editor focuses the input the field names, once per request.
  useEffect(() => {
    if (focus === null || focus === appliedRef.current) return;
    appliedRef.current = focus;
    document.getElementById(fieldIdOf(focus.key))?.focus();
  }, [focus, appliedRef]);

  const set = <K extends keyof PromptDraft>(key: K, value: PromptDraft[K]): void => {
    onEdit((previous) => ({ ...previous, [key]: value }));
  };

  const preview = packPreviewOf(session.state, folderId, template.id, assets);
  const checks: PanelIssue[] = (preview?.issues ?? []).filter((issue) => issue.shotId === shotId);

  const goTo = (key: PromptFieldKey | undefined): void => {
    if (key === undefined) return;
    document.getElementById(fieldIdOf(key))?.focus();
  };

  const save = (): void => {
    const parsed = recordOfDraft(template.id, draft);
    if (!parsed.ok) {
      setMessage(parsed.refusal.message);
      goTo(parsed.refusal.field);
      return;
    }
    const planned = promptEditCommand(session.state, shotId, template.id, draft);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    if (result.ok) onStored(recordOf(session.state, shotId, template.id));
    setMessage(result.ok ? t`Saved the prompt for ${vendor}.` : result.message);
  };

  const remove = (): void => {
    const planned = clearPromptCommand(session.state, shotId, template.id);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    if (result.ok) onStored(undefined);
    setMessage(result.ok ? t`Removed the prompt for ${vendor}.` : result.message);
  };

  const durations = template.limits.durations;
  const duration = draft.durationSec;
  const aspects = template.limits.aspectRatios;
  const resolutions = template.limits.resolutions;

  return (
    <section className="sb-prompt" aria-label={accessibleText(t`Prompt for ${vendor}`)}>
      <h3 className="field-label"><Trans>Prompt</Trans></h3>
      <label className="sb-prompt-vendor">
        <span><Trans>Vendor for this prompt</Trans></span>
        <select id={fieldIdOf('vendor')} value={template.id} onChange={(event) => onVendor(event.target.value)}>
          {PACK_TEMPLATES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.displayName}
            </option>
          ))}
        </select>
      </label>

      {checks.length === 0 ? null : (
        <ul className="findings sb-checks" aria-label={accessibleText(t`Checks for ${vendor}`)}>
          {checks.map((issue) => {
            const key = issue.field === undefined ? undefined : fieldKeyOf(issue.field);
            return (
              <li key={`${issue.code}:${issue.field}:${issue.message}`} className={`pp-issue is-${issue.severity}`}>
                <span className={`badge ${issue.severity === 'error' ? 'is-error' : 'is-warn'}`}>{issue.severity === 'error' ? t`Error` : t`Warning`}</span>{' '}
                {issue.message}
                {key === undefined ? null : (
                  <>
                    {' '}
                    <button type="button" className="button is-quiet" onClick={() => goTo(key)}>
                      <Trans>Go to the field</Trans>
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="sb-prompt-grid">
        <label>
          <span><Trans>Generation mode</Trans></span>
          <select id={fieldIdOf('mode')} value={draft.mode} onChange={(event) => set('mode', event.target.value)}>
            {template.limits.modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 't2v' ? t`Text to video` : t`Image to video`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span><Trans>Prompt: camera</Trans></span>
          <input id={fieldIdOf('prompt.camera')} type="text" value={draft.camera} onChange={(event) => set('camera', event.target.value)} />
        </label>
        <label>
          <span><Trans>Prompt: subject</Trans></span>
          <input id={fieldIdOf('prompt.subject')} type="text" value={draft.subject} onChange={(event) => set('subject', event.target.value)} />
        </label>
        <label>
          <span><Trans>Prompt: action</Trans></span>
          <input id={fieldIdOf('prompt.action')} type="text" value={draft.action} onChange={(event) => set('action', event.target.value)} />
        </label>
        <label>
          <span><Trans>Prompt: context</Trans></span>
          <input id={fieldIdOf('prompt.context')} type="text" value={draft.context} onChange={(event) => set('context', event.target.value)} />
        </label>
        <label>
          <span><Trans>Prompt: style</Trans></span>
          <input id={fieldIdOf('prompt.style')} type="text" value={draft.style} onChange={(event) => set('style', event.target.value)} />
        </label>
        <label>
          <span><Trans>Audio: dialogue, in quotes</Trans></span>
          <input id={fieldIdOf('audio.dialogue')} type="text" value={draft.dialogue} onChange={(event) => set('dialogue', event.target.value)} />
        </label>
        <label>
          <span><Trans>Audio: sound effects</Trans></span>
          <input type="text" value={draft.sfx} onChange={(event) => set('sfx', event.target.value)} />
        </label>
        <label>
          <span><Trans>Audio: ambient sound</Trans></span>
          <input type="text" value={draft.ambient} onChange={(event) => set('ambient', event.target.value)} />
        </label>
        <label>
          <span><Trans>Audio: music</Trans></span>
          <input type="text" value={draft.music} onChange={(event) => set('music', event.target.value)} />
        </label>
        <label>
          <span><Trans>Negative prompt</Trans></span>
          <textarea id={fieldIdOf('negativePrompt')} rows={2} value={draft.negativePrompt} onChange={(event) => set('negativePrompt', event.target.value)} />
        </label>
        <label>
          <span><Trans>Clip length, seconds</Trans></span>
          <select id={fieldIdOf('durationSec')} value={draft.durationSec} onChange={(event) => set('durationSec', event.target.value)}>
            <option value=""><Trans>Not set</Trans></option>
            {durations.map((seconds) => (
              <option key={seconds} value={String(seconds)}>
                {seconds}
              </option>
            ))}
            {draft.durationSec === '' || durations.some((seconds) => String(seconds) === draft.durationSec) ? null : (
              <option value={draft.durationSec}>{t`${duration} (not in the list)`}</option>
            )}
          </select>
        </label>
        <label>
          <span><Trans>Aspect ratio</Trans></span>
          <select id={fieldIdOf('aspectRatio')} value={draft.aspectRatio} onChange={(event) => set('aspectRatio', event.target.value)}>
            <option value=""><Trans>Not set</Trans></option>
            {aspects.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span><Trans>Resolution</Trans></span>
          <select id={fieldIdOf('resolution')} value={draft.resolution} onChange={(event) => set('resolution', event.target.value)}>
            <option value="">{resolutions === undefined ? t`This model takes none` : t`Not set`}</option>
            {(resolutions ?? VIDEO_RESOLUTIONS).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span><Trans>Vendor seed</Trans></span>
          <input id={fieldIdOf('seed')} type="number" min={1} step={1} value={draft.seed} onChange={(event) => set('seed', event.target.value)} />
        </label>
        <label>
          <span><Trans>Vendor model name</Trans></span>
          <input type="text" value={draft.model} onChange={(event) => set('model', event.target.value)} />
        </label>
        {template.limits.promptExtend ? (
          <label className="sb-check">
            <input
              id={fieldIdOf('promptExtend')}
              type="checkbox"
              checked={draft.promptExtend}
              onChange={(event) => set('promptExtend', event.target.checked)}
            />
            <span><Trans>Let the vendor rewrite the prompt</Trans></span>
          </label>
        ) : null}
      </div>

      <fieldset className="sb-references" id={fieldIdOf('references')} tabIndex={-1} aria-label={t`References`}>
        <legend className="field-label"><Trans>References</Trans></legend>
        {draft.references.length === 0 ? (
          <p className="muted"><Trans>No reference is named, so the codex entries the action mentions send theirs.</Trans></p>
        ) : null}
        {draft.references.map((reference, index) => (
          <ReferenceRow
            key={index}
            reference={reference}
            index={index}
            session={session}
            assets={assets}
            onChange={(next) => set('references', draft.references.map((item, at) => (at === index ? next : item)))}
            onRemove={() => set('references', draft.references.filter((_, at) => at !== index))}
          />
        ))}
        <button type="button" className="button is-quiet" onClick={() => set('references', [...draft.references, { type: REFERENCE_TYPES[0], target: '' }])}>
          <Trans>Add a reference</Trans>
        </button>
      </fieldset>

      <fieldset className="sb-take">
        <legend className="field-label"><Trans>Best take</Trans></legend>
        <label className="sb-check">
          <input type="checkbox" checked={draft.keepTake} onChange={(event) => set('keepTake', event.target.checked)} />
          <span><Trans>Keep a take from my own generation</Trans></span>
        </label>
        {draft.keepTake ? (
          <div className="sb-prompt-grid">
            <label>
              <span><Trans>Take seed</Trans></span>
              <input id={fieldIdOf('bestTake.seed')} type="number" min={1} step={1} value={draft.takeSeed} onChange={(event) => set('takeSeed', event.target.value)} />
            </label>
            <label>
              <span><Trans>Take model</Trans></span>
              <input type="text" value={draft.takeModel} onChange={(event) => set('takeModel', event.target.value)} />
            </label>
            <label>
              <span><Trans>Settings, one key: value per line</Trans></span>
              <textarea rows={3} value={draft.takeParams} onChange={(event) => set('takeParams', event.target.value)} />
            </label>
            <label>
              <span><Trans>Note</Trans></span>
              <input type="text" value={draft.takeNote} onChange={(event) => set('takeNote', event.target.value)} />
            </label>
          </div>
        ) : null}
      </fieldset>

      <label>
        <span><Trans>Writer’s note for this shot (not sent to the model)</Trans></span>
        <textarea rows={2} value={draft.notes} onChange={(event) => set('notes', event.target.value)} />
      </label>

      <div className="empty-actions">
        <button type="button" className="button is-primary" onClick={save}>
          <Trans>Save prompt</Trans>
        </button>
        {record === undefined ? null : (
          <button type="button" className="button is-quiet" onClick={remove}>
            <Trans>Remove this prompt</Trans>
          </button>
        )}
      </div>
      {message === null ? null : (
        <p className="drop-note" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}

interface ReferenceRowProps {
  readonly reference: ReferenceDraft;
  readonly index: number;
  readonly session: ProjectSession;
  readonly assets: ReadonlyMap<string, AssetRecord>;
  readonly onChange: (next: ReferenceDraft) => void;
  readonly onRemove: () => void;
}

function ReferenceRow({ reference, index, session, assets, onChange, onRemove }: ReferenceRowProps): ReactNode {
  useLingui();
  const entries = session.state.manifest.codex ?? [];
  const number = index + 1;
  return (
    <div className="sb-reference">
      <label>
        <span>{t`Kind ${number}`}</span>
        <select value={reference.type} onChange={(event) => onChange({ ...reference, type: event.target.value })}>
          {REFERENCE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span><Trans>Names</Trans></span>
        <select value={reference.target} onChange={(event) => onChange({ ...reference, target: event.target.value })}>
          <option value=""><Trans>Choose a codex entry or an image</Trans></option>
          <optgroup label={t`Codex entries`}>
            {entries.map((entry) => (
              <option key={entry.id} value={`entry:${entry.id}`}>
                {entry.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t`Project images`}>
            {[...assets.values()].map((asset) => (
              <option key={asset.id} value={`asset:${asset.id}`}>
                {asset.fileName}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {/* The name starts with the visible word, so a voice control that says "Remove" finds it (WCAG 2.5.3), and it names the reference. */}
      <button type="button" className="button is-quiet" aria-label={accessibleText(t`Remove reference ${number}`)} onClick={onRemove}>
        <Trans>Remove</Trans>
      </button>
    </div>
  );
}
