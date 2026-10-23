/**
 * The rule engine (agent-harness §4, "Rules"): a truth table over `evaluateRules`, the scopes, the withheld set, the refusals and
 * the warnings. Pure functions over a real project tree; the harness and the loop are tested beside this (rules-harness.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { parseRules } from '@caotang/store';

import {
  NO_RULES,
  evaluateRules,
  globMatches,
  ruleRefusal,
  ruleWarnings,
  scopeNodes,
  withheldNodes,
  type CallFacts,
  type CallTargets,
  type RuleSet,
  type SourcedRule,
} from '../src/index.js';
import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, STORM, makeState } from './fixtures.js';

const state = makeState();

const deny = (rule: Partial<SourcedRule> = {}): SourcedRule => ({ effect: 'deny', tool: '*', source: 'project', ...rule });
const ask = (rule: Partial<SourcedRule> = {}): SourcedRule => ({ effect: 'ask', tool: '*', source: 'project', ...rule });
const set = (...rules: SourcedRule[]): RuleSet => ({ rules });

const write: CallFacts = { tool: 'notes.append', external: false, writes: true };
const read: CallFacts = { tool: 'doc.read', external: false, writes: false };
const writing = (...ids: string[]): CallTargets => ({ reads: [], writes: ids });
const reading = (...ids: string[]): CallTargets => ({ reads: ids, writes: [] });

describe('globMatches', () => {
  it('matches a star against any run of characters, and a plain name exactly', () => {
    expect(globMatches('*', 'scene.draft')).toBe(true);
    expect(globMatches('codex.*', 'codex.write')).toBe(true);
    expect(globMatches('codex.*', 'doc.read')).toBe(false);
    expect(globMatches('mcp__notion__*', 'mcp__notion__search')).toBe(true);
    expect(globMatches('mcp__notion__*', 'mcp__linear__search')).toBe(false);
    expect(globMatches('scene.draft', 'scene.draft')).toBe(true);
    expect(globMatches('scene.draft', 'scene.drafts')).toBe(false);
    expect(globMatches('*.read', 'doc.read')).toBe(true);
    expect(globMatches('a*b*c', 'axxbxxc')).toBe(true);
    expect(globMatches('a*b*c', 'axxbxx')).toBe(false);
  });

  it('answers a long text against many stars in the time of a scan', () => {
    const text = 'a'.repeat(5000);
    const started = Date.now();
    expect(globMatches('*a*a*a*a*a*a*a*b', text)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('evaluateRules', () => {
  it('has no verdict without rules', () => {
    expect(evaluateRules(NO_RULES, write, writing(LANDING), state).effect).toBe('none');
  });

  it('denies a call whose target is in the subtree of a rule, the node itself and everything under it', () => {
    const rules = set(deny({ scope: { subtree: CHAPTER_ONE } }));
    for (const id of [CHAPTER_ONE, LANDING, STORM]) expect(evaluateRules(rules, write, writing(id), state).effect).toBe('deny');
    expect(evaluateRules(rules, write, writing(FRIEND), state).effect).toBe('none');
    expect(evaluateRules(rules, write, writing(FRIEND, STORM), state)).toMatchObject({ effect: 'deny', target: STORM });
  });

  it('a write-only deny leaves reads alone, and a read deny implies the write-deny', () => {
    const locked = set(deny({ scope: { subtree: CHAPTER_ONE }, access: 'write' }));
    expect(evaluateRules(locked, read, reading(LANDING), state).effect).toBe('none');
    expect(evaluateRules(locked, write, writing(LANDING), state)).toMatchObject({ effect: 'deny', access: 'write' });
    const hidden = set(deny({ scope: { subtree: CHAPTER_ONE }, access: 'read' }));
    expect(evaluateRules(hidden, read, reading(LANDING), state).effect).toBe('deny');
    expect(evaluateRules(hidden, write, writing(LANDING), state).effect).toBe('deny');
  });

  it('applies a rule with no scope to the tool wherever it is called, and only the tools its pattern names', () => {
    const rules = set(deny({ tool: 'codex.*' }));
    expect(evaluateRules(rules, { tool: 'codex.write', external: false, writes: true }, writing(), state).effect).toBe('deny');
    expect(evaluateRules(rules, write, writing(LANDING), state).effect).toBe('none');
    const onlyWrites = set(deny({ tool: '*', access: 'write' }));
    expect(evaluateRules(onlyWrites, read, reading(LANDING), state).effect).toBe('none');
    expect(evaluateRules(onlyWrites, write, writing(LANDING), state).effect).toBe('deny');
  });

  it('decides by effect order, deny then ask, and never by specificity or by source', () => {
    const broad = deny({ source: 'app', scope: undefined, tool: 'notes.*' });
    const narrow = ask({ source: 'project', scope: { subtree: LANDING } });
    // The ask is the narrower rule, and listed first, and the deny still wins.
    expect(evaluateRules(set(narrow, broad), write, writing(LANDING), state)).toMatchObject({ effect: 'deny' });
    // With no deny, the ask decides.
    expect(evaluateRules(set(narrow), write, writing(LANDING), state)).toMatchObject({ effect: 'ask' });
    // Two denies: the first listed is the one named.
    const first = deny({ source: 'session', note: 'first' });
    const second = deny({ source: 'project', note: 'second' });
    expect(evaluateRules(set(first, second), write, writing(), state)).toMatchObject({ effect: 'deny', rule: { note: 'first' } });
    expect(evaluateRules(set(second, first), write, writing(), state)).toMatchObject({ effect: 'deny', rule: { note: 'second' } });
  });

  it('an ask names exactly the access it states', () => {
    const asked = set(ask({ scope: { subtree: LANDING }, access: 'write' }));
    expect(evaluateRules(asked, write, writing(LANDING), state).effect).toBe('ask');
    expect(evaluateRules(asked, read, reading(LANDING), state).effect).toBe('none');
    const readAsk = set(ask({ scope: { subtree: LANDING }, access: 'read' }));
    expect(evaluateRules(readAsk, read, reading(LANDING), state).effect).toBe('ask');
    expect(evaluateRules(readAsk, write, writing(LANDING), state).effect).toBe('none');
  });

  it('fails closed when a call’s nodes could not be worked out: a scoped deny refuses it, a scoped ask asks, an unscoped rule is unchanged', () => {
    const scoped = set(deny({ scope: { subtree: CHAPTER_ONE } }));
    expect(evaluateRules(scoped, write, undefined, state)).toMatchObject({ effect: 'deny', target: '(unknown)' });
    expect(evaluateRules(set(ask({ scope: { subtree: CHAPTER_ONE } })), write, undefined, state).effect).toBe('ask');
    expect(evaluateRules(set(deny({ scope: { subtree: CHAPTER_ONE }, access: 'write' })), read, undefined, state).effect).toBe('none');
    expect(evaluateRules(set(deny({ tool: 'doc.read', scope: { subtree: CHAPTER_ONE } })), write, undefined, state).effect).toBe('none');
  });

  it('refuses every call that changes the project while the rules cannot be read, and lets reads through', () => {
    const unreadable: RuleSet = { rules: [], unreadable: true };
    expect(evaluateRules(unreadable, write, writing(LANDING), state)).toMatchObject({ effect: 'deny' });
    expect(evaluateRules(unreadable, read, reading(LANDING), state).effect).toBe('none');
  });

  it('is pure: the same inputs give the same verdict', () => {
    const rules = set(deny({ scope: { subtree: CHAPTER_ONE } }), ask({}));
    const a = evaluateRules(rules, write, writing(LANDING), state);
    expect(evaluateRules(rules, write, writing(LANDING), state)).toEqual(a);
  });
});

describe('scopes', () => {
  it('covers a subtree by id, and is inert for a node that is gone', () => {
    expect([...(scopeNodes({ subtree: CHAPTER_TWO }, state.manifest.tree) ?? [])].sort()).toEqual([CHAPTER_TWO, FRIEND].sort());
    expect(scopeNodes({ subtree: 'n_GONE000001' }, state.manifest.tree)).toBeUndefined();
    const dangling = set(deny({ scope: { subtree: 'n_GONE000001' } }));
    expect(evaluateRules(dangling, write, writing(LANDING), state).effect).toBe('none');
  });

  it('resolves a title path against the tree as it is now, with * and ** and the node itself', () => {
    const tree = state.manifest.tree;
    const ids = (path: string): string[] => [...(scopeNodes({ path }, tree) ?? [])].sort();
    expect(ids('Manuscript/Chapter 1')).toEqual([CHAPTER_ONE, LANDING, STORM].sort());
    expect(ids('Manuscript/Chapter 1/**')).toEqual([CHAPTER_ONE, LANDING, STORM].sort());
    expect(ids('Manuscript/*/The Friend')).toEqual([FRIEND]);
    expect(ids('Manuscript/Chapter */The S*')).toEqual([STORM]);
    expect(ids('Manuscript/Nothing')).toEqual([]);
  });

  it('stops matching when a folder is renamed, and says so in the warnings', () => {
    const renamed = makeState();
    const folder = renamed.manifest.tree.find((node) => node.id === CHAPTER_ONE);
    if (folder !== undefined) folder.title = 'Chapter One';
    const rules = set(deny({ scope: { path: 'Manuscript/Chapter 1/**' } }));
    expect(evaluateRules(rules, write, writing(LANDING), renamed).effect).toBe('none');
    expect(ruleWarnings(rules, renamed, ['notes.append']).join(' ')).toContain('matches nothing');
    expect(ruleWarnings(rules, state, ['notes.append']).join(' ')).toContain('renamed');
  });
});

describe('withheldNodes', () => {
  it('is the scope of every deny with read or any access that applies to the tool, and nothing for a write-only deny or an ask', () => {
    const rules = set(
      deny({ scope: { subtree: CHAPTER_ONE }, access: 'read' }),
      deny({ scope: { subtree: CHAPTER_TWO }, access: 'write' }),
      ask({ scope: { subtree: CHAPTER_TWO }, access: 'read' }),
    );
    expect([...withheldNodes(rules, state, 'scene.draft')].sort()).toEqual([CHAPTER_ONE, LANDING, STORM].sort());
  });

  it('withholds from the tools a rule’s pattern names and no others, and nothing for a rule with no scope', () => {
    const rules = set(deny({ tool: 'scene.draft', scope: { subtree: CHAPTER_ONE } }), deny({ tool: 'doc.read' }));
    expect(withheldNodes(rules, state, 'scene.draft').size).toBe(3);
    expect(withheldNodes(rules, state, 'doc.read').size).toBe(0);
    expect(withheldNodes(rules, state, 'meta').size).toBe(0);
  });
});

describe('refusals and warnings', () => {
  it('refuses with permission-denied, naming the source and the note, and never the title of a part the agent may not read', () => {
    const rule = deny({ scope: { subtree: LANDING }, access: 'read', note: 'Private' });
    const verdict = evaluateRules(set(rule), write, writing(LANDING), state);
    if (verdict.effect !== 'deny') throw new Error('expected a deny');
    const error = ruleRefusal(verdict, 'notes.append', state);
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('this project’s file');
    expect(error.message).toContain('Private');
    expect(error.message).not.toContain('The Landing');
    expect(error.correctiveHint).toBeDefined();
  });

  it('names a locked document by title when the rule only locks it, and the operation of a compound call', () => {
    const verdict = evaluateRules(set(deny({ scope: { subtree: LANDING }, access: 'write', source: 'app' })), write, writing(LANDING), state);
    if (verdict.effect !== 'deny') throw new Error('expected a deny');
    expect(ruleRefusal(verdict, 'notes.append', state).message).toContain('"The Landing" is locked against changes by a rule in your app settings');
    const compound = ruleRefusal(verdict, 'binder.restructure', state, 3);
    expect(compound.message).toContain('operation 3');
    expect(compound.target).toBe('params.ops[3]');
  });

  it('warns about a pattern that names no tool, and lets an external pattern and * through', () => {
    const rules = set(deny({ tool: 'scene.drfat' }), deny({ tool: 'mcp__notion__*' }), deny({ tool: '*' }), deny({ tool: 'codex.*' }));
    const warnings = ruleWarnings(rules, state, ['scene.draft', 'codex.read']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('scene.drfat');
  });
});

describe('parseRules', () => {
  it('keeps a well-formed deny and ask, and drops the rest with a warning that names it', () => {
    const parsed = parseRules(
      [
        { effect: 'deny', tool: 'scene.draft', scope: { subtree: CHAPTER_ONE }, access: 'write', note: 'Locked' },
        { effect: 'ask', tool: 'meta.set' },
        { effect: 'allow', tool: 'synopsis.fill' },
        { effect: 'maybe', tool: 'x' },
        { effect: 'deny' },
        { effect: 'deny', tool: 'x', scope: { subtree: '' } },
        { effect: 'deny', tool: 'x', scope: { subtree: 'a', path: 'b' } },
        { effect: 'deny', tool: 'x', access: 'sideways' },
        'nonsense',
      ],
      { at: 'agent.rules' },
    );
    expect(parsed.rules.map((rule) => [rule.effect, rule.tool])).toEqual([
      ['deny', 'scene.draft'],
      ['ask', 'meta.set'],
    ]);
    expect(parsed.warnings).toHaveLength(7);
    // Every dropped rule but the allow is a restriction lost.
    expect(parsed.lost).toBe(6);
    expect(parsed.warnings[0]).toContain('agent.rules[2]');
    expect(parsed.warnings[0]).toContain('allow');
  });

  it('tolerates a value that is not a list, and an app list that carries a scope', () => {
    expect(parseRules('x').rules).toEqual([]);
    expect(parseRules('x').warnings).toHaveLength(1);
    expect(parseRules(undefined)).toEqual({ rules: [], warnings: [], lost: 0 });
    expect(parseRules('x').lost).toBe(1);
    const app = parseRules([{ effect: 'deny', tool: 'x', scope: { subtree: 'n_A' } }, { effect: 'ask', tool: 'y' }], { toolOnly: true });
    expect(app.rules.map((rule) => rule.tool)).toEqual(['y']);
    expect(app.warnings[0]).toContain('binder menu');
  });
});
