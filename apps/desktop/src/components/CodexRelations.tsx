import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Button } from '@ui-sdk/react/button';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import {
  CODEX_RELATION_LABEL_MAX,
  CODEX_RELATION_MAX,
  codexRelationId,
  readCodexRelation,
  type CodexRelation,
  type CodexRelationEdit,
} from '@caotang/bus';
import type { CodexEntry } from '@caotang/store';
import './codex-relations.css';

/**
 * An entry's relations (codex.md §2.3): the links the writer made from this entry, and the links other entries made to it.
 *
 * The outgoing list is the stored one, so what this section edits is exactly what the manifest holds. The incoming list is
 * derived from every entry, is read only here, and says which entry points back — removing it means opening that entry,
 * which is the one place the link lives.
 */
export function CodexRelations({ entry, entries, onEdit, onOpen }: {
  readonly entry: CodexEntry;
  readonly entries: readonly CodexEntry[];
  readonly onEdit: (edit: CodexRelationEdit) => boolean;
  readonly onOpen: (entryId: string) => void;
}): ReactNode {
  useLingui();
  const formId = useId();
  const add = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<CodexRelation | 'new' | null>(null);
  useLayoutEffect(() => {
    if (editing !== null || opener.current === null) return;
    const button = opener.current;
    opener.current = null;
    button.focus();
  }, [editing]);

  const names = new Map(entries.map((candidate) => [candidate.id, candidate.name] as const));
  const outgoing = (entry.relations ?? []).flatMap((value) => {
    const relation = readCodexRelation(value);
    return relation === undefined ? [] : [relation];
  });
  const incoming = entries
    .filter((candidate) => candidate.id !== entry.id)
    .flatMap((candidate) => (candidate.relations ?? []).flatMap((value) => {
      const relation = readCodexRelation(value);
      return relation?.targetId === entry.id ? [{ from: candidate, label: relation.label }] : [];
    }));
  const shown = new Set(outgoing.map((relation) => relation.targetId));
  // A stored relation whose id reads but whose target does not keeps a row of its own, removable: leaving it out would hide a link the
  // writer cannot clear, while it still counts against the 40 this entry may hold. It cannot be named, so it cannot be edited either.
  const readable = new Set(outgoing.map((relation) => relation.id));
  const broken = (entry.relations ?? []).flatMap((value) => {
    const id = codexRelationId(value);
    return id === undefined || readable.has(id) ? [] : [id];
  });
  const held = entry.relations?.length ?? 0;

  return (
    <section className="codex-relations" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}><Trans>Relations</Trans></h3>
      <p className="field-help">
        <Trans>Links to other codex entries. They stay out of automatic model requests.</Trans>
      </p>
      {outgoing.length === 0 && broken.length === 0 ? (
        <p className="field-help"><Trans>This entry links to nothing yet.</Trans></p>
      ) : (
        <ul className="codex-relation-list">
          {outgoing.map((relation) => {
            const title = names.get(relation.targetId) ?? t`A missing entry`;
            return (
              <li key={relation.id} className="codex-relation">
                <Button className="button is-plain codex-relation-target" onClick={() => onOpen(relation.targetId)}
                  disabled={!names.has(relation.targetId)}>
                  {title}
                </Button>
                {relation.label === undefined ? null : <span className="codex-relation-label" dir="auto">{relation.label}</span>}
                <div className="codex-relation-actions">
                  <Button className="button is-quiet" disabled={editing !== null} aria-label={t({ message: `Edit relation to ${{ title }}`, comment: 'title is the linked entry name.' })}
                    onClick={(event) => {
                      opener.current = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
                      setEditing(relation);
                    }}>
                    <Trans>Edit</Trans>
                  </Button>
                  <Button className="button is-quiet" disabled={editing !== null} aria-label={t({ message: `Remove relation to ${{ title }}`, comment: 'title is the linked entry name.' })}
                    onClick={() => { if (onEdit({ action: 'remove', id: relation.id })) add.current?.focus(); }}>
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </li>
            );
          })}
          {broken.map((id) => {
            const title = t`A relation that cannot be shown`;
            return (
              <li key={id} className="codex-relation is-unreadable">
                <span className="codex-relation-target">{title}</span>
                <p className="field-help"><Trans>A field in this relation could not be read. Remove it and add it again.</Trans></p>
                <div className="codex-relation-actions">
                  <Button className="button is-quiet" disabled={editing !== null}
                    aria-label={t({ message: `Remove relation to ${{ title }}`, comment: 'title is the linked entry name.' })}
                    onClick={() => { if (onEdit({ action: 'remove', id })) add.current?.focus(); }}>
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Button className="button is-quiet codex-relation-add" ref={add} disabled={editing !== null || held >= CODEX_RELATION_MAX}
        onClick={(event) => {
          opener.current = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
          setEditing('new');
        }}>
        <Trans>Add relation</Trans>
      </Button>
      {incoming.length === 0 ? null : (
        <>
          <h4 className="codex-relations-subheading"><Trans>Linked from</Trans></h4>
          <ul className="codex-relation-list">
            {incoming.map(({ from, label }) => (
              <li key={from.id} className="codex-relation">
                <Button className="button is-plain codex-relation-target" onClick={() => onOpen(from.id)}>{from.name}</Button>
                {label === undefined ? null : <span className="codex-relation-label" dir="auto">{label}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {editing === null ? null : (
        <RelationForm id={formId} initial={editing === 'new' ? undefined : editing} entries={entries} entry={entry}
          shown={shown} onEdit={onEdit} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

function RelationForm({ id, initial, entries, entry, shown, onEdit, onClose }: {
  readonly id: string;
  readonly initial: CodexRelation | undefined;
  readonly entries: readonly CodexEntry[];
  readonly entry: CodexEntry;
  readonly shown: ReadonlySet<string>;
  readonly onEdit: (edit: CodexRelationEdit) => boolean;
  readonly onClose: () => void;
}): ReactNode {
  useLingui();
  const fieldId = `${id}-relation`;
  const [targetId, setTargetId] = useState(initial?.targetId ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const candidates = entries.filter((candidate) => candidate.id !== entry.id && (candidate.id === initial?.targetId || !shown.has(candidate.id)));

  const save = (): void => {
    if (initial === undefined) {
      if (targetId === '') { setProblem(t`Choose an entry to link to.`); return; }
      if (onEdit({ action: 'create', targetId, ...(label.trim() === '' ? {} : { label: label.trim() }) })) onClose();
      else setProblem(t`That relation could not be saved.`);
      return;
    }
    if (onEdit({ action: 'update', id: initial.id, label: label.trim() === '' ? null : label.trim() })) onClose();
    else setProblem(t`That relation could not be saved.`);
  };

  return (
    <form className="codex-relation-form" aria-labelledby={`${fieldId}-heading`} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h4 id={`${fieldId}-heading`}><Trans>Relation</Trans></h4>
      {initial === undefined ? (
        <Field>
          <FieldLabel><Trans>Linked entry</Trans></FieldLabel>
          <select className="input" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">{t`Choose an entry`}</option>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </Field>
      ) : (
        <p className="field-help">{t({ message: `Links to ${{ name: entries.find((candidate) => candidate.id === initial.targetId)?.name ?? t`a missing entry` }}.`, comment: 'name is the linked entry name, or a missing entry.' })}</p>
      )}
      <Field>
        <FieldLabel><Trans>Label</Trans></FieldLabel>
        <Input value={label} maxLength={CODEX_RELATION_LABEL_MAX} onChange={(event) => setLabel(event.target.value)}
          aria-describedby={`${fieldId}-help`} />
        <p className="field-help" id={`${fieldId}-help`}><Trans>Optional, such as ally or rival.</Trans></p>
      </Field>
      {problem === null ? null : <p className="field-error" role="alert">{problem}</p>}
      <div className="codex-relation-form-actions">
        <Button type="submit" className="button is-primary"><Trans>Save relation</Trans></Button>
        <Button type="button" className="button is-quiet" onClick={onClose}><Trans>Cancel</Trans></Button>
      </div>
    </form>
  );
}
