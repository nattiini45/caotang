/* lingui-set comment="Interpolated values: name, number, event, tool, issuer, document, action, detail" */
import { useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { HOOK_EVENTS, HOOK_NAME_MAX, HOOK_PATTERNS_MAX, HOOK_TEXT_MAX, HOOK_WORDS_MAX, HOOKS_MAX, readHook, type HookCheck, type HookDraft, type HookEvent, type ProjectHook } from '@caotang/bus';
import { DETERMINISTIC_CHECK_IDS } from '@caotang/coherence';
import { createHookRunner, TOOL_NAMES, type HookInput } from '@caotang/harness';
import { getBody } from '@caotang/store';
import { isolate } from '@caotang/i18n';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useSession } from './shared.js';

const blankCheck = (kind: HookCheck['kind']): HookCheck => {
  switch (kind) {
    case 'pattern': return { kind, patterns: [{ match: '', message: '' }] };
    case 'coherence': return { kind, checks: ['pov.coverage'] };
    case 'status': return { kind, allowed: [] };
    case 'words': return { kind, min: 1 };
  }
};
const blankHook = (): HookDraft => ({ name: '', event: 'tool.before', enabled: true, handler: { kind: 'check', check: blankCheck('pattern') } });
const listOf = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
const isToolEvent = (event: HookEvent): boolean => event === 'tool.before' || event === 'tool.after';
const isExportEvent = (event: HookEvent): boolean => event === 'export.before' || event === 'export.after';

export function HookSettings({ session }: { readonly session: ProjectSession | null }): ReactNode {
  return (
    <section className="settings-section" aria-labelledby="settings-hooks" data-testid="hook-settings">
      <h3 id="settings-hooks"><Trans>Hooks</Trans></h3>
      <p className="settings-note"><Trans>Hooks check this project at selected events. They can warn or stop an action, but never approve it, change your text or call a provider.</Trans></p>
      {session === null ? <p className="settings-note"><Trans>Open a project to manage its hooks.</Trans></p> : <ProjectHooks session={session} />}
    </section>
  );
}

function ProjectHooks({ session }: { readonly session: ProjectSession }): ReactNode {
  useSession(session);
  const hooks = session.state.manifest.agent?.hooks ?? [];
  const [draft, setDraft] = useState<HookDraft | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const save = (hook: HookDraft): boolean => {
    const result = session.dispatch('hook.save', { hook });
    setMessage(result.ok ? { text: t`Saved. The hook applies to the next matching event.`, error: false } : { text: explain(result.error), error: true });
    return result.ok;
  };
  const remove = (hook: ProjectHook): void => {
    const result = session.dispatch('hook.delete', { hookId: hook.id });
    setMessage(result.ok ? { text: t`Deleted the hook. Undo brings it back.`, error: false } : { text: explain(result.error), error: true });
  };
  return (
    <>
      {draft === null ? <>
        {hooks.length === 0 ? <p className="settings-note"><Trans>This project has no hooks yet. Add one to check a word, a word count, a status or continuity.</Trans></p> : null}
        <ul className="settings-rules" aria-label={t`Project hooks`}>
          {hooks.map((hook) => {
            const name = isolate(hook.name);
            return <li key={hook.id} data-testid="hook-row">
              <span><strong dir="auto">{hook.name}</strong><br /><code>{hook.event}</code></span>
              <label className="settings-check"><input type="checkbox" checked={hook.enabled} aria-label={t`Enable ${name}`} onChange={(event) => save({ ...hook, enabled: event.target.checked })} /><span><Trans>Enabled</Trans></span></label>
              <div className="profile-actions">
                <button type="button" className="button" onClick={() => { setMessage(null); setDraft(hook); }}><Trans>Edit</Trans><span className="visually-hidden"> {name}</span></button>
                <button type="button" className="button is-quiet is-danger" onClick={() => remove(hook)}><Trans>Delete</Trans><span className="visually-hidden"> {name}</span></button>
              </div>
            </li>;
          })}
        </ul>
        <button type="button" className="button" disabled={hooks.length >= HOOKS_MAX} onClick={() => { setMessage(null); setDraft(blankHook()); }}><Trans>Add hook</Trans></button>
        {hooks.length >= HOOKS_MAX ? <p className="settings-note"><Trans>This project has reached its hook limit. Delete a hook before adding another.</Trans></p> : null}
      </> : <HookForm key={draft.id ?? 'new'} session={session} initial={draft} onCancel={() => setDraft(null)} onSave={(hook) => { if (save(hook)) setDraft(null); }} />}
      {message === null ? null : <p className={`form-message is-${message.error ? 'error' : 'info'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </>
  );
}

function HookForm({ session, initial, onSave, onCancel }: { session: ProjectSession; initial: HookDraft; onSave: (hook: HookDraft) => void; onCancel: () => void }): ReactNode {
  const [hook, setHook] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const check = hook.handler.check;
  const update = (next: HookDraft): void => { setHook(next); setTested(false); setProblem(null); };
  const changeCheck = (next: HookCheck): void => update({ ...hook, handler: { kind: 'check', check: next } });
  const validated = (): HookDraft | null => {
    const result = readHook(hook, false);
    if (!result.ok) { setProblem(explain(result.error)); return null; }
    setProblem(null);
    return result.value;
  };
  const before = hook.event === 'tool.before' || hook.event === 'export.before' || hook.event === 'turn.submit';
  const defaultIssuer = isToolEvent(hook.event) || hook.event === 'turn.submit' || hook.event === 'turn.end' ? 'agent' : 'any';
  return (
    <>
      <form className="settings-form" aria-label={initial.id === undefined ? t`New hook` : t`Edit hook`} onSubmit={(event) => { event.preventDefault(); const value = validated(); if (value !== null) onSave(value); }}>
        <h4>{initial.id === undefined ? <Trans>New hook</Trans> : <Trans>Edit hook</Trans>}</h4>
        <label><span><Trans>Name</Trans></span><input autoFocus required maxLength={HOOK_NAME_MAX} value={hook.name} onChange={(event) => update({ ...hook, name: event.target.value })} /></label>
        <label><span><Trans>Event</Trans></span><select aria-label={t`Event`} value={hook.event} onChange={(event) => update({ ...hook, event: event.target.value as HookEvent })}>{HOOK_EVENTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="settings-check"><input type="checkbox" checked={hook.enabled} onChange={(event) => update({ ...hook, enabled: event.target.checked })} /><span><Trans>Enabled</Trans></span></label>
        <label><span><Trans>Issued by</Trans></span><select aria-label={t`Issued by`} value={hook.matcher?.issuedBy ?? defaultIssuer} onChange={(event) => update({ ...hook, matcher: { ...hook.matcher, issuedBy: event.target.value as 'agent' | 'user' | 'any' } })}>
          <option value="agent">{t`Agent`}</option><option value="user">{t`Writer`}</option><option value="any">{t`Writer or agent`}</option>
        </select></label>
        <label><span><Trans>Tools (optional, comma-separated)</Trans></span><input defaultValue={hook.matcher?.tools?.join(', ') ?? ''} list="hook-tools" onChange={(event) => { const tools = listOf(event.target.value); update({ ...hook, matcher: { issuedBy: hook.matcher?.issuedBy ?? defaultIssuer, ...(tools.length === 0 ? {} : { tools }) } }); }} /></label>
        <p className="settings-note"><Trans>Leave tools blank to match every tool. Use * for a wildcard. Export events use export.compile; save and turn events have no tool.</Trans></p>
        <datalist id="hook-tools">{TOOL_NAMES.map((tool) => <option key={tool} value={tool} />)}<option value="notes.append" /></datalist>
        <label><span><Trans>Check</Trans></span><select aria-label={t`Check`} value={check.kind} onChange={(event) => changeCheck(blankCheck(event.target.value as HookCheck['kind']))}>
          <option value="pattern">{t`Words or phrases`}</option><option value="words">{t`Word count`}</option><option value="status">{t`Document status`}</option><option value="coherence">{t`Continuity checks`}</option>
        </select></label>
        {check.kind === 'pattern' ? <>
          <p className="settings-note"><Trans>Patterns are literal whole words or phrases, not regular expressions.</Trans></p>
          {check.patterns.map((pattern, index) => {
            const number = index + 1;
            return <fieldset key={index}>
              <legend><Trans>Pattern {number}</Trans></legend>
              <label><span><Trans>Word or phrase</Trans></span><input required maxLength={HOOK_TEXT_MAX} value={pattern.match} onChange={(event) => changeCheck({ ...check, patterns: check.patterns.map((item, at) => at === index ? { ...item, match: event.target.value } : item) })} /></label>
              <label><span><Trans>Message when found</Trans></span><input required maxLength={HOOK_TEXT_MAX} value={pattern.message} onChange={(event) => changeCheck({ ...check, patterns: check.patterns.map((item, at) => at === index ? { ...item, message: event.target.value } : item) })} /></label>
              <button type="button" className="button is-quiet" disabled={check.patterns.length === 1} onClick={() => changeCheck({ ...check, patterns: check.patterns.filter((_, at) => at !== index) })}><Trans>Remove pattern</Trans></button>
            </fieldset>;
          })}
          <button type="button" className="button is-quiet" disabled={check.patterns.length >= HOOK_PATTERNS_MAX} onClick={() => changeCheck({ ...check, patterns: [...check.patterns, { match: '', message: '' }] })}><Trans>Add pattern</Trans></button>
        </> : null}
        {check.kind === 'words' ? <>
          <label><span><Trans>Minimum words (optional)</Trans></span><input type="number" min={0} max={HOOK_WORDS_MAX} step={1} value={check.min ?? ''} onChange={(event) => changeCheck({ kind: 'words', ...(check.max === undefined ? {} : { max: check.max }), ...(event.target.value === '' ? {} : { min: Number(event.target.value) }) })} /></label>
          <label><span><Trans>Maximum words (optional)</Trans></span><input type="number" min={0} max={HOOK_WORDS_MAX} step={1} value={check.max ?? ''} onChange={(event) => changeCheck({ kind: 'words', ...(check.min === undefined ? {} : { min: check.min }), ...(event.target.value === '' ? {} : { max: Number(event.target.value) }) })} /></label>
        </> : null}
        {check.kind === 'status' ? <label><span><Trans>Allowed statuses (comma-separated)</Trans></span><input required defaultValue={check.allowed.join(', ')} list="hook-statuses" onChange={(event) => changeCheck({ ...check, allowed: listOf(event.target.value) })} /><datalist id="hook-statuses">{session.state.manifest.vocabulary.statuses.map((status) => <option key={status.id} value={status.name} />)}</datalist></label> : null}
        {check.kind === 'coherence' ? <>
          <fieldset><legend><Trans>Continuity checks</Trans></legend>{[...new Set([...DETERMINISTIC_CHECK_IDS, ...check.checks])].map((id) => <label key={id} className="settings-check"><input type="checkbox" checked={check.checks.includes(id)} onChange={(event) => changeCheck({ ...check, checks: event.target.checked ? [...check.checks, id] : check.checks.filter((item) => item !== id) })} /><span>{id}</span></label>)}</fieldset>
          <label><span><Trans>Minimum finding severity</Trans></span><select aria-label={t`Minimum finding severity`} value={check.severityAtLeast ?? 'info'} onChange={(event) => changeCheck({ ...check, severityAtLeast: event.target.value as 'info' | 'warning' | 'error' })}><option value="info">{t`Info`}</option><option value="warning">{t`Warning`}</option><option value="error">{t`Error`}</option></select></label>
        </> : null}
        <label><span><Trans>When the check fails</Trans></span><select aria-label={t`When the check fails`} value={hook.onBlock ?? 'warn'} onChange={(event) => update({ ...hook, onBlock: event.target.value as 'warn' | 'block' })}><option value="warn">{t`Warn and continue`}</option><option value="block">{t`Block the action`}</option></select></label>
        {!before ? <p className="settings-note"><Trans>This event happens after the action. A hook can report a problem, but cannot undo or block it.</Trans></p> : null}
        <label className="settings-check"><input type="checkbox" checked={hook.failClosed === true} onChange={(event) => update({ ...hook, failClosed: event.target.checked })} /><span><Trans>Block if the check cannot run (before events only)</Trans></span></label>
        {problem === null ? null : <p className="form-message is-error" role="alert">{problem}</p>}
        <div className="profile-actions">
          <button type="submit" className="button is-primary"><Trans>Save hook</Trans></button>
          <button type="button" className="button" aria-expanded={tested} aria-controls={tested ? 'hook-test' : undefined} onClick={() => { if (validated() !== null) setTested(true); }}><Trans>Test hook</Trans></button>
          <button type="button" className="button is-quiet" onClick={onCancel}><Trans>Cancel</Trans></button>
        </div>
      </form>
      {tested ? <HookTest session={session} hook={hook} /> : null}
    </>
  );
}

function HookTest({ session, hook }: { session: ProjectSession; hook: HookDraft }): ReactNode {
  const documents = session.state.manifest.tree.filter((node) => node.type === 'document');
  const [target, setTarget] = useState(documents[0]?.id ?? '');
  const [text, setText] = useState(() => getBody(session.state, target));
  const [tool, setTool] = useState('notes.append');
  const [issuer, setIssuer] = useState<'user' | 'agent'>(hook.matcher?.issuedBy === 'user' || isExportEvent(hook.event) || hook.event === 'project.save' ? 'user' : 'agent');
  const [result, setResult] = useState<{ summary: string; input: string } | null>(null);
  const testTool = isToolEvent(hook.event) ? tool : isExportEvent(hook.event) ? 'export.compile' : '';
  const run = (): void => {
    const input: HookInput = { event: hook.event, issuedBy: issuer, tool: testTool, params: { doc: target, text }, text, affected: [target], write: true };
    const runs = createHookRunner([{ ...hook, id: hook.id ?? 'h_0000000000' }], { state: session.state }).run(input);
    const decision = runs[0]?.decision;
    const action = decision?.action === 'allow' ? t`Passed` : decision?.action === 'block' ? t`Blocked` : decision?.action === 'context' ? t`Note` : t`Warning`;
    const detail = decision === undefined ? '' : decision.action === 'allow' ? t`The check found no problem.` : decision.action === 'context' ? decision.text : decision.reason;
    const document = isolate(documents.find((node) => node.id === target)?.title ?? target);
    const event = hook.event;
    const tool = testTool === '' ? t`None` : testTool;
    setResult({ summary: decision === undefined ? t`Not run. The hook is disabled or its matcher does not match this input.` : t`${action}: ${detail}`, input: t`Tested ${event} · ${tool} · ${issuer} · document: ${document}` });
  };
  return (
    <div className="settings-form" id="hook-test" role="region" aria-label={t`Hook test`}>
      <h4><Trans>Test without changing the project</Trans></h4>
      <p className="settings-note"><Trans>This tests the form above, including unsaved changes. It reads only local project state and the text below. No action runs, no file is written and no provider is called.</Trans></p>
      <p><Trans>Event</Trans> <code>{hook.event}</code></p>
      <label><span><Trans>Test document</Trans></span><select autoFocus aria-label={t`Test document`} value={target} onChange={(event) => { setTarget(event.target.value); setText(getBody(session.state, event.target.value)); setResult(null); }}>{documents.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
      {documents.length === 0 ? <p className="settings-note"><Trans>Add a document to this project before testing a hook.</Trans></p> : null}
      <label><span><Trans>Test tool</Trans></span><input list="hook-tools" value={testTool} readOnly={!isToolEvent(hook.event)} onChange={(event) => { setTool(event.target.value); setResult(null); }} /></label>
      <label><span><Trans>Test issued by</Trans></span><select aria-label={t`Test issued by`} value={issuer} onChange={(event) => { setIssuer(event.target.value as 'user' | 'agent'); setResult(null); }}><option value="agent">{t`Agent`}</option><option value="user">{t`Writer`}</option></select></label>
      <label><span><Trans>Text to test</Trans></span><textarea aria-label={t`Text to test`} rows={5} value={text} onChange={(event) => { setText(event.target.value); setResult(null); }} /></label>
      <p className="settings-note"><Trans>Patterns use this sample. Word counts use it before an action, but read the document after a tool action. Status and continuity checks read the selected document in its current project state.</Trans></p>
      <button type="button" className="button" disabled={target === '' || (isToolEvent(hook.event) && tool.trim() === '')} onClick={run}><Trans>Run test</Trans></button>
      {result === null ? null : <div role="status" data-testid="hook-test-result"><p>{result.input}</p><p>{result.summary}</p></div>}
    </div>
  );
}
