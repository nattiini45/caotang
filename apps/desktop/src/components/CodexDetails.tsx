import { useId, useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Button } from '@ui-sdk/react/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import {
  CODEX_DETAIL_KINDS,
  CODEX_DETAIL_TEXT_MAX,
  matchesCodexDetail,
  type CodexDetailField,
  type CodexDetailKind,
  type CodexDetailValue,
} from '@caotang/bus';
import type { CodexEntry } from '@caotang/store';
import { isImeEnter } from '../app/keymap.js';
import './codex-details.css';

type Choice<T extends string> = { readonly value: T; readonly label: string };

function DetailSelect<T extends string>({ label, value, items, onChange }: {
  readonly label: ReactNode;
  readonly value: T;
  readonly items: readonly Choice<T>[];
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <Select value={value} items={[...items]} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <SelectLabel className="field-label">{label}</SelectLabel>
      <SelectTrigger className="codex-select codex-detail-select">
        <SelectValue />
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"><path d="m4 6 4 4 4-4" /></svg>
      </SelectTrigger>
      <SelectContent className="codex-detail-options">
        {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function DetailValueEditor({ field, stored, onChange }: {
  readonly field: CodexDetailField;
  readonly stored: unknown;
  readonly onChange: (value: CodexDetailValue | null) => boolean;
}): ReactNode {
  const problem = useId();
  const [invalid, setInvalid] = useState(false);
  const value = matchesCodexDetail(field.kind, stored) ? stored : undefined;
  const label = <bdi>{field.label}</bdi>;
  if (field.kind === 'boolean') {
    return (
      <div className="codex-detail-control">
        <DetailSelect label={label} value={value === undefined ? 'unset' : value ? 'yes' : 'no'}
          items={[{ value: 'unset', label: t`Not set` }, { value: 'yes', label: t`Yes` }, { value: 'no', label: t`No` }] as const}
          onChange={(next) => { onChange(next === 'unset' ? null : next === 'yes'); }}
        />
      </div>
    );
  }
  const storedText = value === undefined ? '' : String(value);
  return (
    <Field className="codex-detail-control">
      <FieldLabel className="field-label">{label}</FieldLabel>
      <Input
        key={storedText}
        className="codex-input"
        type={field.kind}
        step={field.kind === 'number' ? 'any' : undefined}
        maxLength={field.kind === 'text' ? CODEX_DETAIL_TEXT_MAX : undefined}
        dir={field.kind === 'text' ? 'auto' : undefined}
        defaultValue={storedText}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? problem : undefined}
        onValueChange={() => setInvalid(false)}
        onBlur={({ currentTarget }) => {
          if (currentTarget.validity.badInput) { setInvalid(true); return; }
          const input = currentTarget.value;
          if (input === storedText) return;
          const next = input === '' ? null : field.kind === 'number' ? currentTarget.valueAsNumber : input;
          setInvalid((next !== null && !matchesCodexDetail(field.kind, next)) || !onChange(next));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !isImeEnter(event)) event.currentTarget.blur();
        }}
      />
      {invalid ? <p id={problem} className="field-help" role="alert"><Trans>Enter a value that matches this field, or clear it.</Trans></p> : null}
    </Field>
  );
}

export function CodexDetails({ entry, fields, onValue, onDefine }: {
  readonly entry: CodexEntry;
  readonly fields: readonly CodexDetailField[];
  readonly onValue: (key: string, value: CodexDetailValue | null) => boolean;
  readonly onDefine: (field: CodexDetailField) => boolean;
}): ReactNode {
  useLingui();
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CodexDetailKind>('text');
  const trigger = useRef<HTMLButtonElement>(null);
  const items = CODEX_DETAIL_KINDS.map((value) => ({
    value,
    label: value === 'text' ? t`Text` : value === 'date' ? t`Date` : value === 'number' ? t`Number` : t`Yes or no`,
  }));
  return (
    <section className="inspector-section" aria-labelledby={heading}>
      <h3 id={heading} className="field-label"><Trans>Details</Trans></h3>
      {fields.filter((field) => field.type === entry.type).map((field) => (
        <DetailValueEditor key={JSON.stringify([entry.type, field.key])} field={field}
          stored={Object.hasOwn(entry.details ?? {}, field.key) ? entry.details?.[field.key] : undefined}
          onChange={(value) => onValue(field.key, value)}
        />
      ))}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="button is-quiet" ref={trigger}><Trans>Add detail field</Trans></CollapsibleTrigger>
        <CollapsiblePanel>
          <form className="codex-detail-control codex-detail-form" aria-label={t`New detail field`} onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const field = { type: String(data.get('type')).trim(), key: String(data.get('key')).trim(), label: String(data.get('label')).trim(), kind };
            if (onDefine(field)) {
              setOpen(false);
              setKind('text');
              trigger.current?.focus();
            }
          }}>
            <p className="field-help"><Trans>Entries of this type share the field. Enter a new type name to use it for this entry.</Trans></p>
            <Field className="codex-detail-control">
              <FieldLabel className="field-label"><Trans>Entry type</Trans></FieldLabel>
              <Input className="codex-input" name="type" dir="auto" key={entry.type} defaultValue={entry.type} required maxLength={64} />
            </Field>
            <Field className="codex-detail-control">
              <FieldLabel className="field-label"><Trans>Field label</Trans></FieldLabel>
              <Input className="codex-input" name="label" dir="auto" required maxLength={80} />
            </Field>
            <Field className="codex-detail-control">
              <FieldLabel className="field-label"><Trans>Field key</Trans></FieldLabel>
              <Input className="codex-input" name="key" dir="ltr" required maxLength={64} pattern={'[A-Za-z][A-Za-z0-9_\\-]*'}
                aria-describedby={`${heading}-key`} />
              <p id={`${heading}-key`} className="field-help"><Trans>Start with a letter A–Z. Use letters A–Z, digits, hyphens or underscores.</Trans></p>
            </Field>
            <DetailSelect label={<Trans>Value type</Trans>} value={kind} items={items} onChange={setKind} />
            <Button className="button" type="submit"><Trans>Save field</Trans></Button>
          </form>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
