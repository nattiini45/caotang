import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { dateTimeFormat } from '@caotang/i18n';
import { Button } from '@ui-sdk/react/button';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Textarea } from '@ui-sdk/react/textarea';
import {
  CODEX_REFERENCE_MAX,
  CODEX_REFERENCE_TITLE_MAX,
  CODEX_REFERENCE_PUBLISHER_MAX,
  CODEX_REFERENCE_QUOTE_MAX,
  CODEX_REFERENCE_URL_MAX,
  CODEX_REFERENCE_FIELDS,
  codexReferenceId,
  externalReferenceUrl,
  readCodexReference,
  type CodexReference,
  type CodexReferenceEdit,
} from '@caotang/bus';
import { formatterLocale } from '../i18n/format-locale.js';
import './codex-references.css';

/* lingui-set comment="Interpolated values: title is the writer's reference title." */
export function CodexReferences({ records, onEdit }: {
  readonly records: readonly unknown[];
  readonly onEdit: (edit: CodexReferenceEdit) => boolean;
}): ReactNode {
  useLingui();
  const heading = useId();
  const formId = useId();
  const add = useRef<HTMLButtonElement>(null);
  const headingElement = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<CodexReference | 'new' | null>(null);
  useLayoutEffect(() => {
    if (editing !== null || opener.current === null) return;
    const button = opener.current;
    opener.current = null;
    if (button.disabled) headingElement.current?.focus();
    else button.focus();
  }, [editing]);
  const ids = records.flatMap((record) => codexReferenceId(record) ?? []);
  const references = records.flatMap((record) => {
    const reference = readCodexReference(record);
    return reference === undefined || ids.filter((id) => id === reference.id).length !== 1 ? [] : [reference];
  });
  return (
    <section className="inspector-section" aria-labelledby={heading}>
      <h3 id={heading} ref={headingElement} tabIndex={-1} className="field-label"><Trans>External references</Trans></h3>
      {references.length === 0 ? <p className="field-help"><Trans>Add the books, articles or sites behind this entry.</Trans></p> : (
        <ul className="codex-reference-list" aria-labelledby={heading}>
          {references.map((reference) => {
            const { title } = reference;
            const href = reference.url === undefined ? undefined : externalReferenceUrl(reference.url);
            return (
              <li key={reference.id} className="codex-reference-item">
                <div className="codex-reference-title" dir="auto">{title}</div>
                {reference.publisher === undefined && reference.date === undefined ? null : (
                  <p className="field-help">
                    {reference.publisher === undefined ? null : <bdi>{reference.publisher}</bdi>}
                    {reference.publisher === undefined || reference.date === undefined ? null : ' · '}
                    {reference.date === undefined ? null : (
                      <time dateTime={reference.date}>{dateTimeFormat(formatterLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(reference.date))}</time>
                    )}
                  </p>
                )}
                {reference.quote === undefined ? null : <blockquote dir="auto">{reference.quote}</blockquote>}
                {href === undefined ? null : (
                  <a className="codex-reference-link" href={href} target="_blank" rel="noopener noreferrer" dir="ltr">
                    {new URL(href).hostname}<span className="visually-hidden"> <Trans>Opens in a new tab</Trans></span>
                  </a>
                )}
                <div className="codex-reference-actions">
                  <Button className="button is-quiet" disabled={editing !== null} aria-label={t`Edit reference ${{ title }}`}
                    onClick={(event) => { opener.current = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null; setEditing(reference); }}>
                    <Trans>Edit</Trans>
                  </Button>
                  <Button className="button is-quiet" disabled={editing !== null} aria-label={t`Remove reference ${{ title }}`}
                    onClick={() => {
                      if (!onEdit({ action: 'remove', id: reference.id })) return;
                      // At the cap the Add button is still disabled on this render, so the heading takes focus instead.
                      if (add.current?.disabled === true) headingElement.current?.focus();
                      else add.current?.focus();
                    }}>
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {references.length < records.length ? (
        <p className="field-help"><Trans>Some saved references could not be shown. They are kept in the project.</Trans></p>
      ) : null}
      {records.length >= CODEX_REFERENCE_MAX ? (
        <p className="field-help"><Trans>Remove a reference before adding another.</Trans></p>
      ) : null}
      <Button className="button is-quiet codex-reference-add" ref={add} disabled={editing !== null || records.length >= CODEX_REFERENCE_MAX}
        onClick={(event) => { opener.current = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null; setEditing('new'); }}>
        <Trans>Add reference</Trans>
      </Button>
      {editing === null ? null : (
        <ReferenceForm id={formId} initial={editing === 'new' ? undefined : editing} onEdit={onEdit} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

function ReferenceForm({ id, initial, onEdit, onClose }: {
  readonly id: string;
  readonly initial: CodexReference | undefined;
  readonly onEdit: (edit: CodexReferenceEdit) => boolean;
  readonly onClose: () => void;
}): ReactNode {
  const [problem, setProblem] = useState(false);
  return (
    <form className="codex-reference-form" aria-labelledby={id} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const title = String(data.get('title') ?? '').trim();
      const url = String(data.get('url') ?? '').trim();
      if (url !== '' && externalReferenceUrl(url) === undefined) { setProblem(true); return; }
      const publisher = String(data.get('publisher') ?? '').trim();
      const date = String(data.get('date') ?? '');
      const quote = String(data.get('quote') ?? '').trim();
      const values = { title, url: url || null, publisher: publisher || null, date: date || null, quote: quote || null };
      if (initial === undefined) {
        if (onEdit({ action: 'create', ...values })) onClose();
      } else {
        const changes = Object.fromEntries(CODEX_REFERENCE_FIELDS.flatMap((key) =>
          values[key] === (initial[key] ?? null) ? [] : [[key, values[key]]]));
        if (Object.keys(changes).length === 0 || onEdit({ action: 'update', id: initial.id, ...changes })) onClose();
      }
    }}>
      <h4 id={id} className="field-label">{initial === undefined ? t`New external reference` : t`Edit external reference`}</h4>
      <Field className="codex-reference-field">
        <FieldLabel className="field-label"><Trans>Reference title</Trans></FieldLabel>
        <Input className="codex-input" name="title" defaultValue={initial?.title ?? ''} required maxLength={CODEX_REFERENCE_TITLE_MAX} dir="auto" autoFocus />
      </Field>
      <Field className="codex-reference-field">
        <FieldLabel className="field-label"><Trans>URL</Trans></FieldLabel>
        <Input className="codex-input" name="url" type="url" maxLength={CODEX_REFERENCE_URL_MAX} defaultValue={initial?.url ?? ''}
          aria-invalid={problem || undefined} aria-describedby={problem ? `${id}-url` : undefined} onValueChange={() => setProblem(false)} dir="ltr" />
        {problem ? <p id={`${id}-url`} className="field-help" role="alert"><Trans>Use an HTTP or HTTPS address without a username or password.</Trans></p> : null}
      </Field>
      <Field className="codex-reference-field">
        <FieldLabel className="field-label"><Trans>Publisher</Trans></FieldLabel>
        <Input className="codex-input" name="publisher" defaultValue={initial?.publisher ?? ''} maxLength={CODEX_REFERENCE_PUBLISHER_MAX} dir="auto" />
      </Field>
      <Field className="codex-reference-field">
        <FieldLabel className="field-label"><Trans>Publication date</Trans></FieldLabel>
        <Input className="codex-input" name="date" type="date" defaultValue={initial?.date ?? ''} />
      </Field>
      <Field className="codex-reference-field">
        <FieldLabel className="field-label"><Trans>Quote</Trans></FieldLabel>
        <Textarea className="codex-description" name="quote" defaultValue={initial?.quote ?? ''} maxLength={CODEX_REFERENCE_QUOTE_MAX} dir="auto" rows={3} />
      </Field>
      <div className="codex-reference-actions">
        <Button className="button is-primary" type="submit"><Trans>Save reference</Trans></Button>
        <Button className="button is-quiet" onClick={onClose}><Trans>Cancel</Trans></Button>
      </div>
    </form>
  );
}
