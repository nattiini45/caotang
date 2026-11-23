/**
 * Settings › Macros ([extensibility.md §10](../../../../docs/architecture/extensibility.md)): the project's macros, saved sequences of steps that
 * the writer runs by hand. A macro is a plan with some values left to fill in. Running one shows the card the agent's plans show, with every
 * step written out, and one undo takes the whole run back. The panel lists, runs, edits and deletes macros; a macro is made from a finished
 * plan card with "Save as macro…" in the agent panel. Nothing here lets the agent run, change or see a macro.
 *
 * It speaks of "macros", "steps" and "values". What a macro is stored as, and how it is checked, are in the docs.
 */
/* lingui-set comment="Macro panel copy. Interpolated values: name is a macro's name, problem is why it cannot run, step and steps are step numbers and counts." */

import { useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { MACRO_DESCRIPTION_MAX, MACRO_NAME_MAX, MACRO_SLUG_MAX, isMacroSlug, placeholdersOf, type MacroDraft, type MacroStep, type ProjectMacro } from '@caotang/bus';

import { agentFor } from '../app/agent.js';
import { fieldsOf, macroRows, riskWord, slugFromName, stepLines, valuesOf, type MacroField, type MacroRow } from '../app/macro-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useReport, useSession } from './shared.js';
import './macros.css';

export interface MacrosPanelProps {
  /** The open project, or `null` on the projects screen, where there is nothing to list. */
  readonly session: ProjectSession | null;
  /** Called once a run has started, so the dialog can step aside and the agent panel show the card. */
  readonly onRan?: () => void;
}

type View = { readonly kind: 'list' } | { readonly kind: 'run'; readonly id: string } | { readonly kind: 'edit'; readonly id: string };

export function MacrosPanel({ session, onRan }: MacrosPanelProps): ReactNode {
  useLingui();
  return (
    <section className="settings-section macros" aria-labelledby="settings-macros" data-testid="macros-panel">
      <h3 id="settings-macros"><Trans>Macros</Trans></h3>
      <p className="settings-note">
        <Trans>A macro is a sequence of steps you save and run yourself, with some values left to fill in. Running one shows a card with every step written
        out, as the agent’s plans do, and you approve it before anything changes. One undo takes a whole run back. The agent cannot see, run or change
        your macros. To make one, finish a plan in the agent panel and choose “Save as macro…” under it.</Trans>
      </p>
      {session === null ? <p className="settings-note"><Trans>Open a project to see its macros.</Trans></p> : <MacroList session={session} onRan={onRan} />}
    </section>
  );
}

function MacroList({ session, onRan }: { session: ProjectSession; onRan?: (() => void) | undefined }): ReactNode {
  useLingui();
  useSession(session);
  const report = useReport();
  const [view, setView] = useState<View>({ kind: 'list' });
  const rows = macroRows(session.macros());

  const remove = (row: MacroRow): void => {
    const result = session.deleteMacro(row.macro.id);
    if (!result.ok) report({ text: explain(result.error), tone: 'error' });
    else report({ text: t`Deleted the macro “${{ name: row.macro.name }}”. Undo brings it back.`, tone: 'info' });
  };

  const current = view.kind === 'list' ? undefined : rows.find((row) => row.macro.id === view.id);
  if (view.kind === 'run' && current !== undefined) {
    return <RunForm session={session} row={current} onBack={() => setView({ kind: 'list' })} onRan={onRan} />;
  }
  if (view.kind === 'edit' && current !== undefined) {
    return <EditForm session={session} macro={current.macro} onBack={() => setView({ kind: 'list' })} />;
  }

  if (rows.length === 0) return <p className="macros-empty"><Trans>This project has no macros yet.</Trans></p>;
  return (
    <ul className="macros-list" aria-label={t`Macros`}>
      {rows.map((row) => (
        <li key={row.macro.id} className="macros-row" data-macro={row.macro.slug} data-testid="macro-row">
          <div className="macros-row-head">
            <strong className="macros-name">{row.macro.name}</strong>
            <span className="chip">{plural({ steps: row.macro.steps.length }, { one: '# step', other: '# steps' })}</span>
          </div>
          {row.macro.description === '' ? null : <p className="macros-description">{row.macro.description}</p>}
          {row.problem !== null ? (
            <p className="macros-problem" role="note">
              <Trans>This macro cannot run now: {{ problem: row.problem }} You can still edit or delete it.</Trans>
            </p>
          ) : (
            <p className="macros-risk">{riskWord(row.risk ?? 'read')}</p>
          )}
          <div className="project-dialog-row">
            <button type="button" className="button is-primary" disabled={row.problem !== null} onClick={() => setView({ kind: 'run', id: row.macro.id })}>
              <Trans>Run…</Trans><span className="visually-hidden"> {row.macro.name}</span>
            </button>
            <button type="button" className="button" onClick={() => setView({ kind: 'edit', id: row.macro.id })}>
              <Trans>Edit</Trans><span className="visually-hidden"> {row.macro.name}</span>
            </button>
            <button type="button" className="button is-quiet is-danger" onClick={() => remove(row)}>
              <Trans>Delete</Trans><span className="visually-hidden"> {row.macro.name}</span>
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

function FieldInput({ field, value, onChange }: { field: MacroField; value: string; onChange: (value: string) => void }): ReactNode {
  useLingui();
  const id = `macro-field-${field.name}`;
  if (field.kind === 'boolean') {
    return (
      <label className="settings-check">
        <input type="checkbox" checked={value === 'true'} onChange={(event) => onChange(event.target.checked ? 'true' : 'false')} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <div className="macros-field">
      <label htmlFor={id}>
        {field.label}
        {field.required ? '' : t` (optional)`}
      </label>
      {field.kind === 'enum' ? (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          {field.values.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} type={field.kind === 'integer' ? 'number' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

function RunForm({ session, row, onBack, onRan }: { session: ProjectSession; row: MacroRow; onBack: () => void; onRan?: (() => void) | undefined }): ReactNode {
  useLingui();
  const macro = row.macro;
  const fields = fieldsOf(macro);
  const [text, setText] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(fields.map((field) => [field.name, field.initial])));
  const [problem, setProblem] = useState<string | null>(null);
  const read = valuesOf(fields, text);
  const preview = 'values' in read ? stepLines(macro, read.values) : read;

  const run = (): void => {
    const agent = agentFor(session);
    if (agent === undefined) {
      setProblem(t`The agent is not ready for this project yet. Close Settings, open the agent panel and try again.`);
      return;
    }
    if (!('values' in read)) {
      setProblem(read.problem);
      return;
    }
    const started = agent.runMacro(macro.id, read.values);
    if (!started.started) {
      setProblem(started.problem);
      return;
    }
    onRan?.();
  };

  return (
    <div className="macros-run" data-testid="macro-run">
      <h4><Trans>Run “{{ name: macro.name }}”</Trans></h4>
      {macro.description === '' ? null : <p className="macros-description">{macro.description}</p>}
      <p className="macros-risk">{riskWord(row.risk ?? 'read')}</p>
      {fields.length === 0 ? <p className="settings-note"><Trans>This macro asks for no values.</Trans></p> : null}
      {fields.map((field) => (
        <FieldInput key={field.name} field={field} value={text[field.name] ?? field.initial} onChange={(value) => setText({ ...text, [field.name]: value })} />
      ))}
      <h5><Trans>The steps it will run</Trans></h5>
      {'lines' in preview ? (
        <ol className="macros-steps" aria-label={t`Steps this run would take`}>
          {preview.lines.map((line, index) => (
            <li key={index}>
              <span className="macros-step-expect">{line.expect}</span>
              <code className="macros-step-tool">{line.tool}</code>
              <code className="macros-step-params">{line.params}</code>
            </li>
          ))}
        </ol>
      ) : (
        <p className="macros-problem" role="status">
          {preview.problem}
        </p>
      )}
      {problem === null ? null : (
        <p className="macros-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="project-dialog-row">
        <button type="button" className="button is-primary" disabled={!('lines' in preview)} onClick={run}>
          <Trans>Show the card</Trans>
        </button>
        <button type="button" className="button" onClick={onBack}>
          <Trans>Back</Trans>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Edit
 * ------------------------------------------------------------------ */

function EditForm({ session, macro, onBack }: { session: ProjectSession; macro: ProjectMacro; onBack: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const [name, setName] = useState(macro.name);
  const [slug, setSlug] = useState(macro.slug);
  const [description, setDescription] = useState(macro.description);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(Object.entries(macro.params.properties).map(([key, spec]) => [key, spec.description])));
  const [expects, setExpects] = useState<readonly string[]>(macro.steps.map((step) => step.expect));
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    const kept = macro.steps.flatMap((step, index): MacroStep[] => (removed.has(index) ? [] : [{ ...step, expect: (expects[index] ?? step.expect).trim() }]));
    if (kept.length === 0) {
      setProblem(t`A macro needs at least one step. To remove the macro, delete it.`);
      return;
    }
    if (name.trim() === '') {
      setProblem(t`Give the macro a name.`);
      return;
    }
    const nextSlug = slug.trim() === '' ? slugFromName(name) : slug.trim();
    if (!isMacroSlug(nextSlug)) {
      setProblem(t`A slug is 1 to ${MACRO_SLUG_MAX} lower-case letters, digits and hyphens.`);
      return;
    }
    const properties = Object.fromEntries(Object.entries(macro.params.properties).map(([key, spec]) => [key, { ...spec, description: (labels[key] ?? spec.description).trim() }]));
    // A value no remaining step uses is dropped with its step, so the macro asks only for what it needs.
    const used = new Set(kept.flatMap((step) => placeholdersOf(step.params)));
    const live = Object.fromEntries(Object.entries(properties).filter(([key]) => used.has(key)));
    const draft: MacroDraft = {
      id: macro.id,
      slug: nextSlug,
      name: name.trim(),
      description,
      params: { ...macro.params, properties: live, required: macro.params.required.filter((key) => key in live) },
      steps: kept,
    };
    const result = session.saveMacro(draft);
    if (!result.ok) {
      setProblem(explain(result.error));
      return;
    }
    report({ text: t`Saved the macro “${{ name: draft.name }}”. Undo brings back the old one.`, tone: 'info' });
    onBack();
  };

  return (
    <div className="macros-edit" data-testid="macro-edit">
      <h4><Trans>Edit “{{ name: macro.name }}”</Trans></h4>
      <div className="macros-field">
        <label htmlFor="macro-name"><Trans>Name</Trans></label>
        <input id="macro-name" type="text" value={name} maxLength={MACRO_NAME_MAX} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="macros-field">
        <label htmlFor="macro-slug"><Trans>Short name</Trans></label>
        <input id="macro-slug" type="text" value={slug} maxLength={MACRO_SLUG_MAX} onChange={(event) => setSlug(event.target.value)} />
        <span className="settings-note"><Trans>Lower-case letters, digits and hyphens. It names the macro in the agent panel’s history and in logs.</Trans></span>
      </div>
      <div className="macros-field">
        <label htmlFor="macro-description"><Trans>Description</Trans></label>
        <textarea id="macro-description" rows={3} value={description} maxLength={MACRO_DESCRIPTION_MAX} onChange={(event) => setDescription(event.target.value)} />
      </div>
      {Object.keys(labels).length === 0 ? null : (
        <fieldset className="macros-values">
          <legend><Trans>What the macro asks for</Trans></legend>
          {Object.keys(labels).map((key) => (
            <div key={key} className="macros-field">
              <label htmlFor={`macro-label-${key}`}>
                <Trans>Label for <code>{key}</code></Trans>
              </label>
              <input id={`macro-label-${key}`} type="text" value={labels[key] ?? ''} onChange={(event) => setLabels({ ...labels, [key]: event.target.value })} />
            </div>
          ))}
        </fieldset>
      )}
      <h5><Trans>Steps</Trans></h5>
      <ol className="macros-steps" aria-label={t`Steps`}>
        {macro.steps.map((step, index) => (
          <li key={index} className={removed.has(index) ? 'is-removed' : undefined}>
            <code className="macros-step-tool">{step.tool}</code>
            <div className="macros-field">
              <label htmlFor={`macro-expect-${index}`}><Trans>What step {{ step: index + 1 }} should do</Trans></label>
              <input
                id={`macro-expect-${index}`}
                type="text"
                value={expects[index] ?? ''}
                disabled={removed.has(index)}
                onChange={(event) => setExpects(expects.map((value, at) => (at === index ? event.target.value : value)))}
              />
            </div>
            <button
              type="button"
              className="button is-quiet"
              onClick={() => {
                const next = new Set(removed);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                setRemoved(next);
              }}
            >
              {removed.has(index) ? t`Keep step` : t`Remove step`}
              <span className="visually-hidden"> {index + 1}</span>
            </button>
          </li>
        ))}
      </ol>
      {problem === null ? null : (
        <p className="macros-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="project-dialog-row">
        <button type="button" className="button is-primary" onClick={save}>
          <Trans>Save</Trans>
        </button>
        <button type="button" className="button" onClick={onBack}>
          <Trans>Cancel</Trans>
        </button>
      </div>
    </div>
  );
}
