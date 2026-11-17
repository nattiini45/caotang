import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Field, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Radio, RadioGroup, RadioIndicator } from '@ui-sdk/react/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { Textarea } from '@ui-sdk/react/textarea';
import { BRANCH_CHECK_IDS, DETERMINISTIC_CHECK_IDS, SCAN_DOC_GUARD, type DeterministicCheckId, type ScopeSpec } from '@caotang/coherence';
import { canonicalJson } from '@caotang/ids';
import { coherenceScopeSize, type Goal, type WriteScope } from '@caotang/harness';

import { goalFromForm, initialGoalForm, type GoalFormResult, type GoalFormValues } from '../app/goal-form.js';
import { checkLabelOf } from '../app/findings-model.js';
import { furnitureId } from '../app/furniture-store.js';
import type { ProjectSession } from '../app/session.js';
import { formatCount } from '../i18n/locale.js';
import { useComposingEnter } from './shared.js';
import './goal-composer.css';

export interface GoalComposerProps {
  readonly open: boolean;
  readonly session: ProjectSession;
  readonly coherenceChecks: readonly DeterministicCheckId[];
  readonly draft: { readonly id: number; readonly intent: string; readonly scope: ScopeSpec; readonly coherenceChecks: readonly DeterministicCheckId[] } | null;
  readonly unavailable: string | null;
  readonly busy: boolean;
  readonly onStart: (goal: Goal, approvedLargeScope: boolean) => void;
  readonly onClose: () => void;
}

type InvalidForm = Extract<GoalFormResult, { ok: false }>;

function formError(error: InvalidForm): string {
  if (error.code === 'checks-off') return t`Choose at least one coherence check that is enabled in Settings.`;
  if (error.field === 'checks') return t`Choose at least one check for the goal to meet.`;
  if (error.field === 'limits') return t`Set at least one shared limit for the whole run.`;
  if (error.field === 'intent') return t`Say what you want the agent to do.`;
  if (error.field === 'scope') return t`Choose a document, or change the check scope.`;
  if (error.code === 'positive') return t`Enter a whole number greater than zero.`;
  if (error.code === 'integer') return t`Enter a non-negative whole number.`;
  if (error.code === 'number') return t`Enter a finite, non-negative number, or leave this optional limit empty.`;
  if (error.field === 'iterations' && error.code === 'range') return t`Use at most 50 iterations.`;
  if (error.code === 'range') return t`The maximum must be at least the minimum.`;
  return t`Fill in this field before starting the goal.`;
}

function Choice({ name, label, checked, onChange, disabled = false }: {
  readonly name: string;
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): ReactNode {
  return <label className="goal-choice">
    <Checkbox name={name} checked={checked} onCheckedChange={(value) => onChange(value === true)} disabled={disabled}>
      <CheckboxIndicator><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></CheckboxIndicator>
    </Checkbox>
    <span>{label}</span>
  </label>;
}

export default function GoalComposer({ open, session, coherenceChecks, draft, unavailable, busy, onStart, onClose }: GoalComposerProps): ReactNode {
  useLingui();
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  const [form, setForm] = useState<GoalFormValues>(() => ({ ...initialGoalForm(), ...(draft === null ? {} : { intent: draft.intent, clean: true }) }));
  const [prefillId, setPrefillId] = useState(draft?.id ?? null);
  const [scope, setScope] = useState<ScopeSpec>(() => draft?.scope ?? { mode: 'full' });
  const [selectedChecks, setSelectedChecks] = useState<readonly DeterministicCheckId[]>(() => [...(draft?.coherenceChecks ?? coherenceChecks)]);
  const [writeScope, setWriteScope] = useState<WriteScope>(() => draft?.scope.mode === 'doc' ? { mode: 'doc', docIds: [...draft.scope.docIds] } : { mode: 'full' });
  const [approval, setApproval] = useState<string | null>(null);
  const [error, setError] = useState<InvalidForm | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  const ime = useComposingEnter();
  const id = useId();
  useEffect(() => { if (open) intentRef.current?.focus(); }, [open, prefillId]);

  if (draft !== null && draft.id !== prefillId) {
    setPrefillId(draft.id);
    setForm({ ...initialGoalForm(), intent: draft.intent, clean: true });
    setScope(structuredClone(draft.scope));
    setWriteScope(draft.scope.mode === 'doc' ? { mode: 'doc', docIds: [...draft.scope.docIds] } : { mode: 'full' });
    setSelectedChecks([...draft.coherenceChecks]);
    setApproval(null);
    setError(null);
  }

  const activeDoc = session.state.manifest.tree.find((node) => node.id === session.view.activeDocId && node.type === 'document' && node.status !== 'archived');
  const update = <K extends keyof GoalFormValues>(key: K, value: GoalFormValues[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setError(null);
    setApproval(null);
  };
  const changeScope = (value: string | null): void => {
    if (value === 'doc') {
      if (activeDoc === undefined) return;
      setScope({ mode: 'doc', docIds: [activeDoc.id] });
    } else if (value === 'full' || value === 'changed') setScope({ mode: value });
    setApproval(null);
    setError(null);
  };
  const result = goalFromForm(form, { id: 'preview', scope, writeScope, coherenceChecks: selectedChecks });
  const definition = result.ok ? canonicalJson(result.goal.checks) : null;
  const documents = form.clean ? coherenceScopeSize(session.state, scope) : 0;
  const overGuard = documents > SCAN_DOC_GUARD;
  const approved = definition !== null && approval === definition;
  const scopeDoc = scope.mode === 'doc' && scope.docIds.length === 1 ? session.state.manifest.tree.find((node) => node.id === scope.docIds[0]) : undefined;
  const fullOnly = selectedChecks.filter((check) => (BRANCH_CHECK_IDS as readonly string[]).includes(check) || check === 'medium.speaker-parity');
  const settingsOff = selectedChecks.filter((check) => !coherenceChecks.includes(check));
  const coherenceProblem = !form.clean ? null
    : settingsOff.length > 0 ? t`A selected check is off in Settings. Deselect it here, or enable it there.`
    : scope.mode === 'doc' && (scope.docIds.length !== 1 || scopeDoc?.type !== 'document') ? t`Coherence needs exactly one document here. Choose the current document or adjust the scope.`
    : scope.mode !== 'full' && fullOnly.length > 0 ? t`Some selected checks require the whole manuscript. Deselect those checks or explicitly choose the whole manuscript.`
    : selectedChecks.length === 0 ? t`Choose at least one enabled coherence check.`
    : null;
  const writeProblem = writeScope.mode === 'doc' && !session.state.manifest.tree.some((node) => writeScope.docIds.includes(node.id) && node.type === 'document' && node.status !== 'archived')
    ? t`The write scope has no live document. Choose the current document or the whole project.` : null;
  const reason = unavailable ?? (busy ? t`A goal or turn is active. Wait for it to finish.` : null) ?? coherenceProblem ?? writeProblem ??
    (overGuard && result.ok && !approved ? t`Approve this large read scope, or narrow the checks before starting.` : null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit() || reason !== null) return;
    const malformed = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input')].find((input) => input.validity.badInput);
    const parsed: GoalFormResult = malformed !== undefined
      ? { ok: false, field: malformed.name as keyof GoalFormValues, code: 'number' }
      : form.status && !session.state.manifest.vocabulary.statuses.some((status) => status.id === form.targetStatus)
        ? { ok: false, field: 'targetStatus', code: 'required' }
        : goalFromForm(form, { id: furnitureId('g'), scope, writeScope, coherenceChecks: selectedChecks });
    if (!parsed.ok) {
      setError(parsed);
      const field = parsed.field === 'limits' ? 'calls' : parsed.field;
      const target = formRef.current?.querySelector<HTMLElement>(`[data-goal-field="${field}"]`);
      (target?.querySelector<HTMLElement>('textarea, input:not([type="hidden"]), button, [tabindex="0"]') ?? target)?.focus();
      return;
    }
    onStart(parsed.goal, overGuard && approved);
  };
  const numeric = (key: keyof GoalFormValues, label: string, integral = true, required = false): ReactNode => <Field
    key={key} name={key} className="goal-field" data-goal-field={key} invalid={error?.field === key ? true : undefined}>
    <FieldLabel>{label}</FieldLabel>
    <Input type="number" min={0} step={integral ? 1 : 'any'} required={required} value={String(form[key])}
      onValueChange={(value) => update(key, value)} />
    {error?.field === key ? <FieldError match>{formError(error)}</FieldError> : null}
  </Field>;

  if (!open) return null;

  return <form className="goal-composer" ref={formRef} noValidate aria-labelledby={`${id}-title`} onKeyDown={ime.noteKey} onSubmit={submit}>
    <header className="goal-composer-heading">
      <h3 id={`${id}-title`}><Trans>Run toward a goal</Trans></h3>
    </header>
    <div className="goal-composer-fields">
      <p className="goal-help"><Trans>Choose what must pass. Each turn keeps your permission mode and approval cards.</Trans></p>
      <Field name="intent" className="goal-field" data-goal-field="intent" invalid={error?.field === 'intent' ? true : undefined}>
        <FieldLabel><Trans>Goal intent</Trans></FieldLabel>
        <Textarea ref={intentRef} rows={3} required value={form.intent} onValueChange={(value) => update('intent', value)} />
        {error?.field === 'intent' ? <FieldError match>{formError(error)}</FieldError> : null}
      </Field>
      <fieldset data-goal-field="scope" tabIndex={-1}>
        <legend><Trans>Check scope</Trans></legend>
        <RadioGroup aria-label={t`Check scope`} name="goal-scope" value={scope.mode} onValueChange={changeScope}>
          <label className="goal-choice"><Radio value="full"><RadioIndicator /></Radio><span><Trans>Whole manuscript</Trans></span></label>
          <label className="goal-choice"><Radio value="doc" disabled={activeDoc === undefined && scope.mode !== 'doc'}><RadioIndicator /></Radio><span>{scope.mode === 'doc' ? t`Named document scope` : t`Current document`}</span></label>
          <label className="goal-choice"><Radio value="changed"><RadioIndicator /></Radio><span><Trans>Changed since the last review</Trans></span></label>
        </RadioGroup>
        {scope.mode === 'doc' ? <p className="goal-help"><Trans>Requested documents:</Trans> <bdi>{scope.docIds.map((docId) => session.state.manifest.tree.find((node) => node.id === docId)?.title ?? docId).join(', ')}</bdi></p> : null}
        {scope.mode === 'doc' && activeDoc !== undefined && (scope.docIds.length !== 1 || scope.docIds[0] !== activeDoc.id) ? <Button className="button" onClick={() => changeScope('doc')}><Trans>Use the current document</Trans></Button> : null}
        {error?.field === 'scope' ? <p className="form-message is-error">{formError(error)}</p> : null}
      </fieldset>
      <fieldset data-goal-field="checks" tabIndex={-1}>
        <legend><Trans>Checks that must pass</Trans></legend>
        <Choice name="goal-clean" label={t`No open coherence findings`} checked={form.clean} onChange={(value) => update('clean', value)} />
        {form.clean ? <fieldset className="goal-coherence-checks">
          <legend><Trans>Coherence checks to include</Trans></legend>
          <p className="goal-help"><Trans>Your selection stays explicit when Settings change. Checks marked as off must be enabled there or deselected here.</Trans></p>
          {DETERMINISTIC_CHECK_IDS.filter((check) => coherenceChecks.includes(check) || selectedChecks.includes(check)).map((check) => {
            const needsFull = (BRANCH_CHECK_IDS as readonly string[]).includes(check) || check === 'medium.speaker-parity';
            const off = !coherenceChecks.includes(check);
            return <Choice key={check} name={`goal-check-${check}`} checked={selectedChecks.includes(check)} disabled={off && !selectedChecks.includes(check)}
              label={<>{checkLabelOf(check)}{off ? <span className="goal-help"> — <Trans>Off in Settings</Trans></span> : null}{needsFull ? <span className="goal-help"> — <Trans>Whole manuscript only</Trans></span> : null}</>}
              onChange={(checked) => { setSelectedChecks((previous) => checked ? [...previous, check] : previous.filter((id) => id !== check)); setApproval(null); setError(null); }} />;
          })}
          {coherenceProblem === null ? null : <p className="form-message is-error">{coherenceProblem}</p>}
        </fieldset> : null}
        <Choice name="goal-words" label={t`Every document meets a word range`} checked={form.words} onChange={(value) => update('words', value)} />
        {form.words ? <div className="goal-number-row">{numeric('minWords', t`Minimum words per document`)}{numeric('maxWords', t`Maximum words per document`)}</div> : null}
        <Choice name="goal-status" label={t`Every document has a status`} checked={form.status} onChange={(value) => update('status', value)} />
        {form.status ? <Field name="targetStatus" className="goal-field" data-goal-field="targetStatus" invalid={error?.field === 'targetStatus' ? true : undefined}>
          <FieldLabel><Trans>Target status</Trans></FieldLabel>
          <Select name="targetStatus" value={form.targetStatus} onValueChange={(value) => update('targetStatus', value ?? '')}
            items={session.state.manifest.vocabulary.statuses.map((status) => ({ value: status.id, label: status.name }))}>
            <SelectTrigger className="button"><SelectValue placeholder={t`Choose a status`} /></SelectTrigger>
            <SelectContent className="goal-status-options" container={typeof document === 'undefined' ? undefined : document.body}>
              {session.state.manifest.vocabulary.statuses.map((status) => <SelectItem key={status.id} value={status.id}><bdi>{status.name}</bdi></SelectItem>)}
            </SelectContent>
          </Select>
          {error?.field === 'targetStatus' ? <FieldError match>{formError(error)}</FieldError> : null}
        </Field> : null}
        <Choice name="goal-synopses" label={t`Every synopsis is filled`} checked={form.synopses} onChange={(value) => update('synopses', value)} />
        {form.synopses ? numeric('synopsisWords', t`Maximum words per synopsis (optional)`) : null}
        {error?.field === 'checks' ? <p className="form-message is-error">{formError(error)}</p> : null}
      </fieldset>
      <fieldset>
        <legend><Trans>Where the agent may write</Trans></legend>
        <RadioGroup aria-label={t`Write scope`} name="goal-write-scope" value={writeScope.mode} onValueChange={(value) => {
          if (value === 'full') setWriteScope({ mode: 'full' });
          else if (value === 'doc' && activeDoc !== undefined) setWriteScope({ mode: 'doc', docIds: [activeDoc.id] });
        }}>
          <label className="goal-choice"><Radio value="full"><RadioIndicator /></Radio><span><Trans>Whole project</Trans></span></label>
          <label className="goal-choice"><Radio value="doc" disabled={activeDoc === undefined && writeScope.mode !== 'doc'}><RadioIndicator /></Radio><span>{writeScope.mode === 'doc' ? t`Only the named document` : t`Only the current document`}</span></label>
        </RadioGroup>
        {writeScope.mode === 'doc' ? <p className="goal-help"><Trans>Allowed document:</Trans> <bdi>{session.state.manifest.tree.find((node) => node.id === writeScope.docIds[0])?.title ?? writeScope.docIds[0]}</bdi></p> : null}
        {writeScope.mode === 'doc' && activeDoc !== undefined && writeScope.docIds[0] !== activeDoc.id ? <Button className="button" onClick={() => setWriteScope({ mode: 'doc', docIds: [activeDoc.id] })}><Trans>Write only in the current document</Trans></Button> : null}
      </fieldset>
      <fieldset>
        <legend><Trans>Shared limits for the whole run</Trans></legend>
        <p className="goal-help"><Trans>Set at least one limit. Empty limits are unlimited; zero allows no use. Model calls may incur provider charges.</Trans></p>
        <div className="goal-number-row">
          {numeric('calls', t`Model-call limit`)}{numeric('tokens', t`Token limit`, false)}{numeric('cost', t`Cost limit (USD)`, false)}
          {numeric('steps', t`Step limit`)}{numeric('minutes', t`Active-time limit (minutes)`, false)}
        </div>
        {error?.field === 'limits' ? <p className="form-message is-error">{formError(error)}</p> : null}
        <div className="goal-number-row">{numeric('iterations', t`Maximum iterations (1–50)`, true, true)}{numeric('stall', t`Stop after iterations without progress`, true, true)}</div>
      </fieldset>
      {overGuard ? <div className="goal-scope-approval">
        <p><Trans>This coherence scope reads more than 20 documents.</Trans> <Trans>Documents in scope:</Trans> {formatCount(documents)}</p>
        <Choice name="goal-large-scope" label={t`I approve reading this large scope for these checks`} checked={approved} onChange={(value) => setApproval(value ? definition : null)} disabled={definition === null} />
        {definition === null ? <p className="goal-help"><Trans>Complete the required goal fields before approving this read scope.</Trans></p> : null}
      </div> : null}
    </div>
    <footer className="goal-composer-footer">
      {error === null ? null : <p className="form-message is-error" role="alert">{formError(error)}</p>}
      <p id={`${id}-reason`} className="goal-help">{reason ?? t`The goal starts only when you choose Start the goal.`}</p>
      <div className="goal-composer-actions">
        <Button type="button" className="button" onClick={onClose}><Trans>Back to one turn</Trans></Button>
        <Button type="submit" className="button is-primary goal-start" disabled={reason !== null} focusableWhenDisabled aria-describedby={`${id}-reason`} data-agent-confirm={t`Starts an agent goal that may call your model provider and change this project under your permission mode`}><Trans>Start the goal</Trans></Button>
      </div>
    </footer>
  </form>;
}
