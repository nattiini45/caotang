/* lingui-set comment="Read-only MCP hooks in project Settings." */
import { useEffect, useId, useReducer, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { HOOK_NAME_MAX } from '@caotang/bus';
import { TOOL_NAMES, metadataFor, validateMcpReadHook, type McpReadHook } from '@caotang/harness';
import { newId } from '@caotang/ids';
import { MCP_HOOK_LIMIT, mcpHooksForProject } from '../app/mcp-hooks.js';
import type { AppServices } from '../app/services.js';
import './mcp-hook-settings.css';

type Target = Pick<McpReadHook, 'serverKey' | 'toolName' | 'pin'>;
const valueOf = (target: Target): string => JSON.stringify([target.serverKey, target.toolName, target.pin]);
const eventLabel = (event: McpReadHook['event']): string => event === 'tool.before' ? t`Before the agent tool runs` : t`After the agent tool runs`;
const triggerTools = TOOL_NAMES.filter(name => {
  const meta = metadataFor(name);
  return name !== 'agent.delegate' && meta !== undefined && meta.risk !== 'meta' && meta.externalOnly !== true;
});

function SelectCaret(): ReactNode {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

export function McpHookSettings({ projectId, services }: { readonly projectId: string; readonly services: AppServices }): ReactNode {
  const settings = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const client = services.mcp.client;
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [editing, setEditing] = useState<McpReadHook | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const heading = useId();
  useEffect(() => {
    const health = client.onHealthChange(refresh);
    const list = client.onToolListChanged(refresh);
    return () => { health(); list(); };
  }, [client]);
  const hooks = mcpHooksForProject(settings.mcpHooks, projectId);
  if (!settings.mcp.enabled && hooks.length === 0) return null;
  const choices = client.indexedTools().tools.flatMap(tool => {
    const target = { serverKey: tool.serverKey, toolName: tool.toolName, pin: tool.candidateHash };
    if (!settings.mcp.enabled || !validateMcpReadHook(client, target).ok) return [];
    return [{ ...target, label: `${tool.serverName} › ${tool.toolName}` }];
  });
  const persist = async (next: readonly McpReadHook[], success: string): Promise<void> => {
    if (saving.current) return;
    if (services.db === null) {
      setMessage({ text: t`This browser cannot save MCP hooks. Open Caotang in a browser that allows local storage.`, error: true });
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const error = await services.settings.update({ mcpHooks: { [projectId]: next } }, { publishAfterSave: true });
      setMessage(error === null ? { text: success, error: false } : { text: error, error: true });
      if (error === null) setEditing(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="mcp-hook-settings" aria-labelledby={heading}>
      <h4 id={heading}><Trans>Read-only MCP hooks</Trans></h4>
      <p className="settings-note"><Trans>These hooks stay in this browser. They call a tool on a server you trust for reads. They send no manuscript text or tool arguments.</Trans></p>
      {editing === null ? <>
        <ul className="settings-rules" aria-labelledby={heading}>{hooks.map(hook => (
          <li key={hook.id}>
            <span><strong dir="auto">{hook.name}</strong><br />{eventLabel(hook.event)}: <bdi>{hook.tool}</bdi></span>
            <div className="profile-actions">
              <Button className="button" disabled={busy} onClick={() => { setMessage(null); setEditing(hook); }}><Trans>Edit</Trans><span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
              <Button className="button" disabled={busy} onClick={() => {
                if (!hook.enabled && !validateMcpReadHook(client, hook).ok) {
                  setMessage({ text: t`Connect and review the tool again in MCP & tools, then edit this hook to select it.`, error: true });
                  return;
                }
                return persist(hooks.map(item => item.id === hook.id ? { ...item, enabled: !item.enabled } : item), t`Saved the MCP hook.`);
              }}>{hook.enabled ? <Trans>Disable</Trans> : <Trans>Enable</Trans>}<span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
              <Button className="button is-quiet is-danger" disabled={busy} onClick={() => persist(hooks.filter(item => item.id !== hook.id), t`Deleted the MCP hook.`)}><Trans>Delete</Trans><span className="visually-hidden"> <bdi>{hook.name}</bdi></span></Button>
            </div>
          </li>
        ))}</ul>
        <Button className="button" disabled={busy || choices.length === 0 || hooks.length >= MCP_HOOK_LIMIT} onClick={() => { setMessage(null); setEditing('new'); }}><Trans>Add MCP hook</Trans></Button>
        {choices.length === 0 ? <p className="settings-note"><Trans>In MCP & tools, connect and review a server, trust it for reads, and enable a read-only tool that takes no required arguments.</Trans></p> : null}
        {hooks.length >= MCP_HOOK_LIMIT ? <p className="settings-note"><Trans>Delete an MCP hook before adding another.</Trans></p> : null}
      </> : <McpHookForm initial={editing === 'new' ? undefined : editing} choices={choices} busy={busy} onCancel={() => { setMessage(null); setEditing(null); }} onSave={draft => {
        if (!validateMcpReadHook(client, draft).ok) {
          setMessage({ text: t`This tool is no longer available for hooks. Review it in MCP & tools, then choose it again.`, error: true });
          return;
        }
        const id = editing === 'new' ? newId('r', { taken: new Set(hooks.map(hook => hook.id)) }) : editing.id;
        const hook = { ...draft, id };
        return persist(editing === 'new' ? [...hooks, hook] : hooks.map(item => item.id === id ? hook : item), t`Saved the MCP hook.`);
      }} />}
      {message === null ? null : <p className={`form-message is-${message.error ? 'error' : 'info'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}

function McpHookForm({ initial, choices, busy, onCancel, onSave }: {
  readonly initial: McpReadHook | undefined;
  readonly choices: readonly (Target & { readonly label: string })[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (value: Omit<McpReadHook, 'id'>) => void | Promise<void>;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? '');
  const [tool, setTool] = useState(initial?.tool ?? '');
  const [event, setEvent] = useState<McpReadHook['event']>(initial?.event ?? 'tool.before');
  const [failure, setFailure] = useState(initial?.failClosed ?? false);
  const [target, setTarget] = useState(initial === undefined ? null : valueOf(initial));
  const [invalid, setInvalid] = useState<'name' | 'tool' | 'target' | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const toolField = useRef<HTMLInputElement>(null);
  const targetField = useRef<HTMLButtonElement>(null);
  const list = useId();
  const problem = useId();
  useEffect(() => {
    if (invalid === 'name') nameField.current?.focus();
    if (invalid === 'tool') toolField.current?.focus();
    if (invalid === 'target') targetField.current?.focus();
  }, [invalid]);
  const submit = (submission: FormEvent<HTMLFormElement>): void => {
    submission.preventDefault();
    if (busy) return;
    if (name.trim() === '') { setInvalid('name'); return; }
    if (!triggerTools.some(candidate => candidate === tool.trim())) { setInvalid('tool'); return; }
    const selected = choices.find(choice => valueOf(choice) === target);
    if (selected === undefined) { setInvalid('target'); return; }
    setInvalid(null);
    void onSave({ name: name.trim(), tool: tool.trim(), event, failClosed: event === 'tool.before' && failure, enabled: initial?.enabled ?? true, serverKey: selected.serverKey, toolName: selected.toolName, pin: selected.pin });
  };
  const error = invalid === 'name' ? t`Enter a name for this hook.` : invalid === 'tool' ? t`Choose a built-in agent tool.` : t`Choose an available read-only MCP tool.`;
  return (
    <form className="settings-form" aria-label={initial === undefined ? t`New MCP hook` : t`Edit MCP hook`} noValidate onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>{initial === undefined ? <Trans>New MCP hook</Trans> : <Trans>Edit MCP hook</Trans>}</legend>
        <Field><FieldLabel><Trans>Name</Trans></FieldLabel><Input ref={nameField} autoFocus required maxLength={HOOK_NAME_MAX} value={name} aria-invalid={invalid === 'name'} aria-describedby={invalid === 'name' ? problem : undefined} onValueChange={value => { setName(value); setInvalid(null); }} /></Field>
        <Field><FieldLabel><Trans>Built-in agent tool</Trans></FieldLabel><Input ref={toolField} required list={list} value={tool} aria-invalid={invalid === 'tool'} aria-describedby={invalid === 'tool' ? problem : undefined} onValueChange={value => { setTool(value); setInvalid(null); }} /></Field>
        <datalist id={list}>{triggerTools.map(candidate => <option key={candidate} value={candidate} />)}</datalist>
        <Field>
          <FieldLabel><Trans>Event</Trans></FieldLabel>
          <Select value={event} items={(['tool.before', 'tool.after'] as const).map(value => ({ value, label: eventLabel(value) }))} onValueChange={value => { if (value === 'tool.before' || value === 'tool.after') setEvent(value); }}>
            <SelectTrigger className="button"><SelectValue /><SelectCaret /></SelectTrigger>
            <SelectContent className="mcp-hook-options"><SelectItem value="tool.before">{eventLabel('tool.before')}</SelectItem><SelectItem value="tool.after">{eventLabel('tool.after')}</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel><Trans>MCP tool</Trans></FieldLabel>
          <Select value={target} items={choices.map(choice => ({ value: valueOf(choice), label: choice.label }))} onValueChange={value => { setTarget(value); setInvalid(null); }}>
            <SelectTrigger ref={targetField} className="button" aria-invalid={invalid === 'target'} aria-describedby={invalid === 'target' ? problem : undefined}><SelectValue placeholder={t`Choose a read-only MCP tool`} /><SelectCaret /></SelectTrigger>
            <SelectContent className="mcp-hook-options">{choices.map(choice => <SelectItem key={valueOf(choice)} value={valueOf(choice)}><bdi>{choice.label}</bdi></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {event === 'tool.before' ? <label className="settings-check"><Checkbox className="mcp-hook-check" checked={failure} onCheckedChange={value => setFailure(value === true)}><CheckboxIndicator><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></CheckboxIndicator></Checkbox><span><Trans>Block if the MCP hook cannot run</Trans></span></label> : null}
        {invalid === null ? null : <p id={problem} className="form-message is-error" role="alert">{error}</p>}
        <div className="profile-actions"><Button type="submit" className="button is-primary"><Trans>Save MCP hook</Trans></Button><Button className="button is-quiet" onClick={onCancel}><Trans>Cancel</Trans></Button></div>
      </fieldset>
    </form>
  );
}
