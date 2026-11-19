/* lingui-set comment="Private Background model hook settings." */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { Textarea } from '@ui-sdk/react/textarea';
import { HOOK_NAME_MAX } from '@caotang/bus';
import { MODEL_HOOK_LIMIT, MODEL_HOOK_PROMPT_MAX, MODEL_HOOK_TOOLS, type ModelHook } from '@caotang/harness';
import { newId } from '@caotang/ids';
import { canTransformModelHook, modelHooksForProject } from '../app/model-hooks.js';
import type { AppServices } from '../app/services.js';
import './mcp-hook-settings.css';

const events = ['tool.before', 'tool.after', 'turn.end'] as const;
const eventLabel = (event: ModelHook['event']): string => {
  switch (event) {
    case 'tool.before': return t`Before the agent tool runs`;
    case 'tool.after': return t`After the agent tool runs`;
    case 'turn.end': return t`When the agent finishes a turn`;
  }
};
type Draft = Omit<Extract<ModelHook, { event: 'turn.end' }>, 'id'> | Omit<Exclude<ModelHook, { event: 'turn.end' }>, 'id'>;

function SelectCaret(): ReactNode {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

export function ModelHookSettings({ projectId, services }: { readonly projectId: string; readonly services: Pick<AppServices, 'db' | 'settings'> }): ReactNode {
  const settings = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const hooks = modelHooksForProject(settings.modelHooks, projectId);
  const [editing, setEditing] = useState<ModelHook | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const saving = useRef(false);
  const restoreFocus = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const disclosure = useId();
  useEffect(() => {
    if (editing !== null || busy || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (addButton.current?.disabled === false) addButton.current.focus();
    else headingRef.current?.focus();
  }, [editing, busy]);
  const closeEditor = (): void => { restoreFocus.current = true; setEditing(null); };
  const persist = async (next: readonly ModelHook[], success: string, moveFocus = false): Promise<void> => {
    if (saving.current) return;
    if (services.db === null) {
      setMessage({ text: t`This browser cannot save model hooks. Open Caotang in a browser that allows local storage.`, error: true });
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const error = await services.settings.update({ modelHooks: { [projectId]: next } }, { publishAfterSave: true });
      setMessage(error === null ? { text: success, error: false } : { text: error, error: true });
      if (error === null && moveFocus) closeEditor();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="model-hook-settings" aria-labelledby={heading} data-testid="model-hook-settings">
      <h4 id={heading} ref={headingRef} tabIndex={-1}><Trans>Model hooks</Trans></h4>
      <p className="settings-note" id={disclosure}><Trans>Enabled model hooks send your check instructions to the provider configured for the Background role. Tool hooks also send the tool name and a limited amount of task text. Hook settings stay in this browser and are not included in project files or bundles.</Trans></p>
      <p className="settings-note"><Trans>The demo does not run model hooks. To use them, choose a non-demo provider for Background under Providers. Saving a hook does not send a test request.</Trans></p>
      {editing === null ? <>
        {hooks.length === 0 ? null : <ul className="settings-rules" aria-labelledby={heading}>{hooks.map(hook => (
          <li key={hook.id}>
            <span><strong dir="auto">{hook.name}</strong><br />{eventLabel(hook.event)}{hook.event === 'turn.end' ? null : <>: <bdi>{hook.tool}</bdi></>}</span>
            <div className="profile-actions">
              <Button className="button" disabled={busy} onClick={() => { setMessage(null); setEditing(hook); }}><Trans>Edit</Trans><span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
              <Button className="button" disabled={busy} data-agent-confirm={hook.enabled ? undefined : hook.event === 'turn.end' ? t`Enables a hook that sends check instructions and turn status to the Background provider` : t`Enables a hook that sends limited task text to the Background provider`} onClick={() => persist(
                hooks.map(item => item.id === hook.id ? { ...item, enabled: !item.enabled } : item),
                hook.enabled ? t`Disabled the model hook.` : t`Enabled the model hook.`,
              )}>{hook.enabled ? <Trans>Disable</Trans> : <Trans>Enable</Trans>}<span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
              <Button className="button is-quiet is-danger" disabled={busy} data-agent-confirm={t`Deletes this private model hook`} onClick={() => persist(hooks.filter(item => item.id !== hook.id), t`Deleted the model hook.`, true)}><Trans>Delete</Trans><span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
            </div>
          </li>
        ))}</ul>}
        <Button ref={addButton} className="button" disabled={busy || hooks.length >= MODEL_HOOK_LIMIT} onClick={() => { setMessage(null); setEditing('new'); }}><Trans>Add model hook</Trans></Button>
        {hooks.length >= MODEL_HOOK_LIMIT ? <p className="settings-note"><Trans>Delete a model hook before adding another.</Trans></p> : null}
      </> : <ModelHookForm initial={editing === 'new' ? undefined : editing} busy={busy} disclosure={disclosure} onCancel={() => { setMessage(null); closeEditor(); }} onSave={draft => {
        const id = editing === 'new' ? newId('r', { taken: new Set(hooks.map(hook => hook.id)) }) : editing.id;
        const hook = { ...draft, id };
        return persist(editing === 'new' ? [...hooks, hook] : hooks.map(item => item.id === id ? hook : item), t`Saved the model hook.`, true);
      }} />}
      <p className={message?.error === false ? 'form-message is-info' : 'visually-hidden'} role="status">{message?.error === false ? message.text : ''}</p>
      {message?.error === true ? <p className="form-message is-error" role="alert">{message.text}</p> : null}
    </section>
  );
}

function ModelHookForm({ initial, busy, disclosure, onCancel, onSave }: {
  readonly initial: ModelHook | undefined;
  readonly busy: boolean;
  readonly disclosure: string;
  readonly onCancel: () => void;
  readonly onSave: (draft: Draft) => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? '');
  const [tool, setTool] = useState<string | null>(initial?.tool || null);
  const [event, setEvent] = useState<ModelHook['event']>(initial?.event ?? 'tool.before');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [failure, setFailure] = useState(initial?.failClosed ?? false);
  const [transform, setTransform] = useState(initial?.canTransform === true);
  const [invalid, setInvalid] = useState<'name' | 'tool' | 'prompt' | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const toolField = useRef<HTMLButtonElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const problem = useId();
  const turnHelp = useId();
  const transformHelp = useId();
  const turnEnd = event === 'turn.end';
  const transformAvailable = canTransformModelHook(event, tool);
  const reject = (field: NonNullable<typeof invalid>): void => {
    setInvalid(field);
    ({ name: nameField, tool: toolField, prompt: promptField })[field].current?.focus();
  };
  const submit = (submission: FormEvent<HTMLFormElement>): void => {
    submission.preventDefault();
    if (busy) return;
    if (name.trim() === '' || name.length > HOOK_NAME_MAX) return reject('name');
    if (event !== 'turn.end' && (tool === null || !MODEL_HOOK_TOOLS.some(candidate => candidate === tool))) return reject('tool');
    if (prompt.trim() === '' || prompt.length > MODEL_HOOK_PROMPT_MAX) return reject('prompt');
    setInvalid(null);
    const common = { name: name.trim(), prompt: prompt.trim(), enabled: initial?.enabled ?? true };
    void onSave(event === 'turn.end' ? { ...common, event, tool: '', failClosed: false } : {
      ...common, tool: tool ?? '', event,
      failClosed: event === 'tool.before' && failure,
      ...(transformAvailable && transform ? { canTransform: true } : {}),
    });
  };
  const label = initial === undefined ? t`New model hook` : t`Edit model hook`;
  const nameLimit = HOOK_NAME_MAX;
  const promptLimit = MODEL_HOOK_PROMPT_MAX;
  const error = invalid === 'name' ? t`Enter a name with at most ${nameLimit} characters.` : invalid === 'tool' ? t`Choose a built-in agent tool.` : t`Enter check instructions with at most ${promptLimit} characters.`;
  return (
    <form className="settings-form" aria-label={label} aria-describedby={disclosure} method="post" noValidate onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>{label}</legend>
        <Field><FieldLabel><Trans>Name</Trans></FieldLabel><Input ref={nameField} autoFocus required maxLength={HOOK_NAME_MAX} value={name} aria-invalid={invalid === 'name'} aria-describedby={invalid === 'name' ? problem : undefined} onValueChange={value => { setName(value); if (invalid === 'name') setInvalid(null); }} /></Field>
        <Field>
          <FieldLabel><Trans>Event</Trans></FieldLabel>
          <Select value={event} items={events.map(value => ({ value, label: eventLabel(value) }))} onValueChange={value => {
            if (value === null || value === event) return;
            setEvent(value);
            setTransform(false);
            if (value === 'turn.end' && invalid === 'tool') setInvalid(null);
          }}>
            <SelectTrigger className="button" aria-describedby={turnEnd ? turnHelp : undefined}><SelectValue /><SelectCaret /></SelectTrigger>
            <SelectContent className="mcp-hook-options">{events.map(value => <SelectItem key={value} value={value}>{eventLabel(value)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {turnEnd ? (
          <p className="settings-note" id={turnHelp}><Trans>After a successful turn, the Background provider receives your check instructions and the turn status, not the conversation, manuscript or tool results. The hook can ask the agent to continue up to twice per turn, within the same call, spending and time limits. New tool calls still follow the usual approval rules.</Trans></p>
        ) : <Field>
          <FieldLabel><Trans>Built-in agent tool</Trans></FieldLabel>
          <Select required value={tool} items={[...MODEL_HOOK_TOOLS]} onValueChange={value => {
            if (value !== tool) setTransform(false);
            setTool(value);
            if (invalid === 'tool') setInvalid(null);
          }}>
            <SelectTrigger ref={toolField} className="button" aria-invalid={invalid === 'tool'} aria-describedby={invalid === 'tool' ? problem : undefined}><SelectValue placeholder={t`Choose a built-in agent tool`} /><SelectCaret /></SelectTrigger>
            <SelectContent className="mcp-hook-options">{MODEL_HOOK_TOOLS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
          </Select>
        </Field>}
        <Field>
          <FieldLabel><Trans>Check instructions</Trans></FieldLabel>
          <Textarea ref={promptField} rows={4} required maxLength={MODEL_HOOK_PROMPT_MAX} value={prompt} aria-invalid={invalid === 'prompt'} aria-describedby={invalid === 'prompt' ? problem : undefined} onValueChange={value => { setPrompt(value); if (invalid === 'prompt') setInvalid(null); }} />
        </Field>
        {event === 'tool.before' ? <Checkbox className="model-hook-checkbox" checked={failure} onCheckedChange={value => setFailure(value === true)}>
          <span className="mcp-hook-check" aria-hidden="true"><CheckboxIndicator><svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg></CheckboxIndicator></span>
          <span><Trans>Block the tool if the model hook cannot run</Trans></span>
        </Checkbox> : event === 'tool.after' ? <p className="settings-note"><Trans>An after hook can warn you, but it cannot stop or undo the tool action.</Trans></p> : null}
        {transformAvailable ? <div>
          <Checkbox className="model-hook-checkbox" checked={transform} aria-describedby={transformHelp} onCheckedChange={value => setTransform(value === true)}>
            <span className="mcp-hook-check" aria-hidden="true"><CheckboxIndicator><svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg></CheckboxIndicator></span>
            <span><Trans>Let this hook propose replacement text</Trans></span>
          </Checkbox>
          <p className="settings-note" id={transformHelp}><Trans>The hook can only propose a change to the note or synopsis text. You review the original and the replacement on a new approval card, even in Auto mode.</Trans></p>
        </div> : null}
        {invalid === null ? null : <p id={problem} className="form-message is-error" role="alert">{error}</p>}
        <div className="profile-actions"><Button type="submit" className="button is-primary" data-agent-confirm={t`Saves private instructions for a model hook`}><Trans>Save model hook</Trans></Button><Button type="button" className="button is-quiet" onClick={onCancel}><Trans>Cancel</Trans></Button></div>
      </fieldset>
    </form>
  );
}
