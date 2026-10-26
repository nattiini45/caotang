/**
 * The permission gate — [command-bus.md §4](docs/architecture/command-bus.md).
 *
 * §10 names this slice's exit criterion in one clause: *"permission-matrix
 * assertions (each `never` command refused for agent, allowed/destructive-confirmed
 * for user)"*, and §4 adds the one that is not a matrix at all — a hard-deny class
 * is *"non-approvable by any flow"*. A matrix is a truth table over the closed set;
 * "no flow reaches it" is a statement about the gate's **control flow**, and it is
 * the kind of property a truth table never catches, because every row of the matrix
 * can look correct while the ordering underneath them is wrong.
 *
 * So the file is in three parts: the matrix itself, the flow test, and the
 * read-through that stops the gate's two hard-coded lists (§4's four classes, and
 * which name performs one) from being compared only with themselves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_NAMES,
  COMMAND_REGISTRY,
  HARD_DENIED,
  HARD_DENY_CLASSES,
  checkPermission,
  hardDenyClass,
  type AgentRisk,
  type CommandName,
  type PermissionContext,
  type PermissionGrant,
} from '../src/index.js';

const specPath = resolve(__dirname, '../../../docs/architecture/command-bus.md');

/**
 * Every context a caller can hand the gate, so "no flow" is testable.
 *
 * **The space is 2³, and all eight are here.** The gate reads exactly three things
 * about a context — whether `inheritedGrant` is *present*, whether `approvedPlan`
 * is *true*, whether `confirmed` is *true* — and nothing reads the inherited grant's
 * **value**, so eight boolean triples are the whole set of distinguishable inputs.
 *
 * Six were listed first, and the three that combine an inherited grant with a plan
 * and/or a card were missing: not because they behave differently (they do not, and
 * a test asserting that they did would be asserting an accident), but because "under
 * every flow the gate knows about" was true of the flows this file happened to know.
 * A case first added when a mutation needs it is a case written after the fact — the
 * standing species this file already guards against in `HARD_DENIED`, in the one
 * place the enumeration is the guard.
 */
const ALL_FLOWS: ReadonlyArray<readonly [string, PermissionContext]> = [
  ['no plan, no card', {}],
  ['approved plan', { approvedPlan: true }],
  ['confirm card', { confirmed: true }],
  ['approved plan + card', { approvedPlan: true, confirmed: true }],
  ['inherited grant', { inheritedGrant: 'write-confirm' }],
  ['inherited write-auto grant', { inheritedGrant: 'write-auto' }],
  ['inherited + approved plan', { approvedPlan: true, inheritedGrant: 'write-confirm' }],
  ['inherited + confirm card', { confirmed: true, inheritedGrant: 'write-confirm' }],
  [
    'inherited + plan + card',
    { approvedPlan: true, confirmed: true, inheritedGrant: 'write-confirm' },
  ],
];

function gate(
  name: CommandName,
  issuedBy: 'user' | 'agent',
  context: PermissionContext = {},
  params?: unknown,
): ReturnType<typeof checkPermission> {
  return checkPermission(COMMAND_REGISTRY[name].descriptor, { name, issuedBy, params }, context);
}

function granted(
  name: CommandName,
  issuedBy: 'user' | 'agent',
  context: PermissionContext = {},
  params?: unknown,
): PermissionGrant {
  const result = gate(name, issuedBy, context, params);
  if (!result.ok) {
    throw new Error(`expected ${name} (${issuedBy}) to be granted, got: ${result.error.message}`);
  }
  return result.value;
}

function refused(name: CommandName, issuedBy: 'user' | 'agent', context: PermissionContext = {}, params?: unknown) {
  const result = gate(name, issuedBy, context, params);
  expect(result.ok, `${name} (${issuedBy}) should have been refused`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

/** §9's `never`-class names, read from the registry rather than typed out again. */
const NEVER_CLASS = COMMAND_NAMES.filter((n) => COMMAND_REGISTRY[n].descriptor.agentRisk === 'never');

describe('§4 the hard-deny list is not approvable by any flow', () => {
  // The test the build row names, and it pins one thing well: an approved plan
  // cannot rescue a hard-denied class, which `agentRisk: 'never'` would otherwise
  // carry to `ok` on the strength of §4's *other* bullet.
  //
  // **It does not pin the ordering.** Re-derived in both directions: removing the
  // hard-deny check fails **3** tests, and
  // moving it below the inherited-grant branch fails **exactly 1** — the flow sweep
  // below, not this one. A plan is not an inherited grant, so the ordering mutant
  // leaves this test green.
  it('refuses project.deleteNode for an agent even inside an approved plan', () => {
    const error = refused('project.deleteNode', 'agent', { approvedPlan: true, confirmed: true });
    expect(error.code).toBe('hard-denied');
  });

  it('refuses it under every flow the gate knows about, not just the approved one', () => {
    // **This is the test that pins the ordering.** The mutant is moving hard-deny
    // below the inherited-grant branch, and only the inherited flows reach it —
    // the approved-plan flow is unchanged by it, which is why the test above cannot
    // see it. Re-derivation: this one fails under that mutant and the test
    // above stays green.
    for (const [flow, context] of ALL_FLOWS) {
      const error = refused('project.deleteNode', 'agent', context);
      expect(error.code, `flow: ${flow}`).toBe('hard-denied');
    }
  });

  it('names the class, and §4\'s own corrective path for deletion', () => {
    const error = refused('project.deleteNode', 'agent');
    expect(error.message).toContain('project.deleteNode');
    expect(error.message).toContain('deletion');
    // §4's example, in the gate's own words: deletion is UI-only and gets proposed
    // in the report. A refusal that only said "denied" would leave the model with
    // nothing to do but retry.
    expect(error.correctiveHint).toContain('propose it in your report');
    expect(error.correctiveHint).toContain('deletion is UI-only');
    // And it says the class is unreachable rather than merely unapproved, so the
    // model does not try to find a flow that would work.
    expect(error.correctiveHint).toContain('no plan, card or mode approves it');
  });

  it('states that nothing was written — §3\'s zero partial effects, on this path too', () => {
    const error = refused('project.deleteNode', 'agent');
    expect(error.message).toContain('nothing was written');
  });

  it('carries risk: \'never\', the field §7 declares for gate rejections', () => {
    const error = refused('project.deleteNode', 'agent');
    expect(error.risk).toBe('never');
    expect(error.target).toBe('project.deleteNode');
  });
});

describe('§4 issuedBy: \'user\' — a gesture is its own confirmation', () => {
  it('allows every command in the closed set, including the hard-denied one', () => {
    for (const name of COMMAND_NAMES) {
      const result = gate(name, 'user');
      expect(result.ok, `${name} must be allowed for a user`).toBe(true);
    }
  });

  it('flags the destructive gesture for a confirm dialog and leaves the other 17 unflagged', () => {
    // §4: "only destructive commands (project.deleteNode) add an explicit confirm
    // dialog (UI responsibility)". Flagging it is the gate's whole contribution —
    // the UI cannot tell a destructive command from a rename by looking at it.
    expect(granted('project.deleteNode', 'user').requiresUserConfirm).toBe(true);
    const flagged = COMMAND_NAMES.filter((n) => granted(n, 'user').requiresUserConfirm);
    expect(flagged).toEqual(['project.deleteNode', 'memory.forget']);
  });

  it('grants every user command via user-gesture, whatever the plan context says', () => {
    // A user gesture needs no plan, and a plan must not change how it was allowed.
    expect(granted('binder.rename', 'user').via).toBe('user-gesture');
    expect(granted('binder.rename', 'user', { approvedPlan: true }).via).toBe('user-gesture');
  });
});

describe('§4 issuedBy: \'agent\' — the risk matrix', () => {
  it('refuses every never-class command for an agent (§10\'s first clause)', () => {
    // Not a hand-written list: the names are read from the registry, so a command
    // promoted to `never` later cannot slip past this matrix unasserted.
    expect(NEVER_CLASS.length).toBeGreaterThan(0);
    for (const name of NEVER_CLASS) {
      const error = refused(name, 'agent');
      expect(['permission-denied', 'hard-denied'], name).toContain(error.code);
    }
  });

  it('refuses a direct emission of a never-class primitive even inside an approved plan', () => {
    // §4's sentence is precise and both halves are load-bearing: "*Direct* agent
    // emission of a `never`-class command is refused even inside approved plans."
    for (const name of NEVER_CLASS) {
      if (HARD_DENIED[name] !== undefined) continue; // covered by the hard-deny block
      const error = refused(name, 'agent', { approvedPlan: true, confirmed: true });
      expect(error.code, name).toBe('permission-denied');
    }
  });

  it('lets that same primitive run when it inherits a compound tool\'s grant', () => {
    // §4's grant inheritance: "internal primitives (editor.replaceRange inside
    // scene.draft) inherit the compound tool's granted permission and are never
    // individually gated". Without this the `never` rows would be unrunnable code.
    const inherited = granted('editor.replaceRange', 'agent', { inheritedGrant: 'write-confirm' });
    expect(inherited.via).toBe('inherited');
    expect(inherited.risk).toBe('never');
    // Inheritance is not free rein: it is still a `never` command underneath.
    expect(inherited.requiresUserConfirm).toBe(false);
  });

  it('allows the two auto classes with no plan, no card and no grant', () => {
    for (const name of COMMAND_NAMES) {
      const risk = COMMAND_REGISTRY[name].descriptor.agentRisk;
      if (risk !== 'read' && risk !== 'write-auto') continue;
      expect(granted(name, 'agent').via, name).toBe('auto');
    }
  });

  it('refuses write-confirm with neither an approved plan nor a confirm card', () => {
    // `coherence.setFindingStatus` is the one write-confirm name whose agent answer depends on its params
    // (coherence.md §6.3: the agent may set `fixed` and nothing else). Its refusal is the status refusal,
    // which is tested on its own below, so this generic row leaves it out rather than pass it for the
    // wrong reason. It is the list's only param-dependent member.
    const confirmClass = COMMAND_NAMES.filter(
      (n) => COMMAND_REGISTRY[n].descriptor.agentRisk === 'write-confirm' && n !== 'coherence.setFindingStatus',
    );
    expect(confirmClass.length).toBeGreaterThan(0);
    for (const name of confirmClass) {
      const error = refused(name, 'agent');
      expect(error.code, name).toBe('permission-denied');
      expect(error.risk, name).toBe('write-confirm');
    }
  });

  it('hard-refuses an agent dismissal of a finding, through every flow the gate reads (coherence.md §6.3, §7.1)', () => {
    const dismiss = { findingId: 'f_AAAAAAAAAA', status: 'dismissed', reason: 'false-positive' };
    // Neither an approved plan, a confirm card nor an inherited grant carries a dismissal past the gate.
    for (const flow of [{}, { approvedPlan: true }, { confirmed: true }, { inheritedGrant: 'write-confirm' as const }]) {
      const error = refused('coherence.setFindingStatus', 'agent', flow, dismiss);
      expect(error.code, JSON.stringify(flow)).toBe('hard-denied');
      expect(error.message).toContain('dismissal is a writer judgment');
    }
    // The writer's own gesture is not refused: a UI dismissal is the writer's judgment, made in the inbox.
    expect(granted('coherence.setFindingStatus', 'user', {}, dismiss).via).toBe('user-gesture');
  });

  it('lets an agent mark a finding fixed only through an approved plan or an inherited grant (coherence.md §7 tool 17)', () => {
    const fix = { findingId: 'f_AAAAAAAAAA', status: 'fixed' };
    // Direct agent emission still needs an approval, as any write-confirm command does.
    expect(refused('coherence.setFindingStatus', 'agent', {}, fix).code).toBe('permission-denied');
    expect(granted('coherence.setFindingStatus', 'agent', { approvedPlan: true }, fix).via).toBe('approved-plan');
    // The coherence tool's grant, which is how the agent's fix reaches the bus (tools/coherence.ts).
    expect(granted('coherence.setFindingStatus', 'agent', { inheritedGrant: 'write-confirm' }, fix).via).toBe('inherited');
  });

  it('refuses the agent any status but fixed, re-opening included', () => {
    const reopen = { findingId: 'f_AAAAAAAAAA', status: 'open' };
    const error = refused('coherence.setFindingStatus', 'agent', { approvedPlan: true, inheritedGrant: 'write-confirm' }, reopen);
    expect(error.code).toBe('hard-denied');
    expect(error.message).toContain('may set only "fixed"');
  });

  it('allows write-confirm inside an approved plan, and behind a one-step confirm card', () => {
    expect(granted('doc.write', 'agent', { approvedPlan: true }).via).toBe('approved-plan');
    expect(granted('doc.write', 'agent', { confirmed: true }).via).toBe('confirm-card');
    // §4 names both, so both are honoured — an approved plan must not be the only door.
    expect(granted('doc.write', 'agent', { approvedPlan: true, confirmed: true }).via).toBe(
      'approved-plan',
    );
  });

  it('tells the model not to retry a write-confirm refusal as a bare call', () => {
    const error = refused('doc.write', 'agent');
    expect(error.message).toContain('doc.write');
    expect(error.message).toContain('nothing was written');
    // §4's two doors, named as surfaces the model can actually use.
    expect(error.correctiveHint).toContain('plan card');
    expect(error.correctiveHint).toContain('confirm card');
    expect(error.correctiveHint).toContain('do not retry it as a bare call');
  });

  it('never lets a refusal be a bare code — §7, on all three refusal paths', () => {
    const paths: ReadonlyArray<readonly [CommandName, PermissionContext]> = [
      ['project.deleteNode', {}],
      ['editor.insert', {}],
      ['doc.write', {}],
    ];
    for (const [name, context] of paths) {
      const error = refused(name, 'agent', context);
      expect(error.message, name).not.toBe(error.code);
      expect(error.message.length, name).toBeGreaterThan(40);
      expect(error.correctiveHint, name).toBeTruthy();
      expect(error.correctiveHint, name).toContain('do not retry');
    }
  });
});

describe('the gate is a pure function of its three arguments', () => {
  it('never throws, for any name in the closed set in either direction', () => {
    // A gate that throws on one path makes that refusal indistinguishable from a
    // crash, which is exactly what `resolveCommand` had to be hardened against.
    for (const name of COMMAND_NAMES) {
      for (const issuedBy of ['user', 'agent'] as const) {
        for (const [, context] of ALL_FLOWS) {
          expect(() => gate(name, issuedBy, context), `${name}/${issuedBy}`).not.toThrow();
        }
      }
    }
  });

  it('answers identically for identical arguments, and mutates nothing it was given', () => {
    const command = { name: 'binder.move' as CommandName, issuedBy: 'agent' as const };
    const context: PermissionContext = { approvedPlan: true };
    const first = checkPermission(COMMAND_REGISTRY['binder.move'].descriptor, command, context);
    const second = checkPermission(COMMAND_REGISTRY['binder.move'].descriptor, command, context);
    expect(first).toEqual(second);
    expect(command).toEqual({ name: 'binder.move', issuedBy: 'agent' });
    expect(context).toEqual({ approvedPlan: true });
  });

  it('does not read the registry to decide — a descriptor passed by hand is enough', () => {
    // Proves the gate is a function of what it is handed, not a lookup against
    // COMMAND_REGISTRY: a hand-made descriptor object with the same risk answers
    // the same way, so nothing can be smuggled in through the global table.
    const handMade = checkPermission(
      { agentRisk: 'write-confirm' },
      { name: 'doc.write', issuedBy: 'agent' },
      {},
    );
    expect(handMade.ok).toBe(false);
    const alsoHandMade = checkPermission(
      { agentRisk: 'write-confirm' },
      { name: 'doc.write', issuedBy: 'agent' },
      { approvedPlan: true },
    );
    expect(alsoHandMade.ok).toBe(true);
  });

  it('reports every `via` at least once, so no branch is unreachable', () => {
    const seen = new Set<string>();
    for (const name of COMMAND_NAMES) {
      for (const issuedBy of ['user', 'agent'] as const) {
        for (const [, context] of ALL_FLOWS) {
          const result = gate(name, issuedBy, context);
          if (result.ok) seen.add(result.value.via);
        }
      }
    }
    expect([...seen].sort()).toEqual([
      'approved-plan',
      'auto',
      'confirm-card',
      'inherited',
      'user-gesture',
    ]);
  });
});

describe('the gate\'s own lists are held against the spec, not against themselves', () => {
  /**
   * A hand-written copy of §4's hard-deny bullet can only be compared with itself,
   * which proves nothing — a stale copy would still report itself as current. So the bullet is read out of the
   * file, and each declared class must still be named in it.
   */
  it('declares exactly the four classes §4\'s bullet names, and finds that bullet', () => {
    const spec = readFileSync(specPath, 'utf8');
    const bullet = spec
      .split('\n')
      .find((line) => line.includes('non-approvable'));
    // The control assertion: a bullet that stops existing must fail loudly rather
    // than leave four classes matching nothing.
    expect(bullet, '§4 no longer contains a "non-approvable" bullet').toBeDefined();
    const anchors: ReadonlyArray<readonly [string, string]> = [
      ['network-egress', 'network egress beyond the configured provider endpoint'],
      ['deletion', 'deleting nodes or codex entries'],
      ['provider-profile', 'mutating provider profiles'],
      ['project-scope', 'leaving project scope'],
    ];
    expect(HARD_DENY_CLASSES).toHaveLength(anchors.length);
    expect([...HARD_DENY_CLASSES].sort()).toEqual(anchors.map(([id]) => id).sort());
    for (const [id, phrase] of anchors) {
      expect(bullet, `${id} must still be named in §4`).toContain(phrase);
    }
  });

  it('hard-denies exactly two commands, and both are deletions', () => {
    // Three of §4's four classes have no command in §9's closed set (the bus has no
    // network, provider settings are app-level, and codex deletion is not an
    // `action` value yet). A third member therefore cannot be added without this
    // failing and naming it. `memory.forget` is the second: a memory note is the writer's to remove.
    expect(Object.keys(HARD_DENIED)).toEqual(['project.deleteNode', 'memory.forget']);
    expect(hardDenyClass('project.deleteNode')).toBe('deletion');
    expect(hardDenyClass('memory.forget')).toBe('deletion');
    expect(hardDenyClass('binder.rename')).toBeUndefined();
  });

  it('keeps the hard-deny list and the never-class list in agreement', () => {
    // Two lists that could disagree are the standing species in a new place. Every
    // hard-denied name must be `never` (or the class would be softer than its
    // descriptor), and every `never` name that is *not* hard-denied must be an
    // inheritable primitive (§9 glosses those "never (direct) — inheritable as
    // internal composition").
    for (const name of Object.keys(HARD_DENIED) as CommandName[]) {
      expect(COMMAND_REGISTRY[name].descriptor.agentRisk, name).toBe('never');
    }
    const inheritable = NEVER_CLASS.filter((n) => HARD_DENIED[n] === undefined);
    // The four skill commands are `never` too, and nothing composes them: the harness's allowlist of primitives excludes them
    // (`NEVER_EXPOSED`), so an agent reaches a skill only through the user's own gesture. `mcp.readResource` is the same: the writer's
    // pick is the only way to it, and no tool is written over it.
    expect([...inheritable].sort()).toEqual(['editor.insert', 'editor.replaceRange', 'mcp.readResource', 'skill.delete', 'skill.import', 'skill.setEnabled', 'skill.write']);
    for (const name of inheritable) {
      expect(granted(name, 'agent', { inheritedGrant: 'write-confirm' }).via, name).toBe('inherited');
    }
  });

  it('agrees with the registry on every risk class the gate reads', () => {
    // The matrix above is derived from the registry, so it is only a claim about
    // §4 if §9's own column still says the same thing. The registry test already
    // pins the columns; this asserts the gate consumes them unchanged.
    const byRisk = new Map<AgentRisk, CommandName[]>();
    for (const name of COMMAND_NAMES) {
      const risk = COMMAND_REGISTRY[name].descriptor.agentRisk;
      byRisk.set(risk, [...(byRisk.get(risk) ?? []), name]);
    }
    // The two binder/corkboard view names carry `read` too: they are ephemeral, so
    // the gate has nothing to protect and an agent may move the binder's cursor.
    expect(byRisk.get('read')).toEqual([
      'view.setSelection',
      'view.setActiveDoc',
      'view.setScroll',
      'view.setExpanded',
      'view.setCorkboardScope',
    ]);
    expect(byRisk.get('never')).toEqual([
      'editor.insert',
      'editor.replaceRange',
      'project.deleteNode',
      'mcp.readResource',
      'skill.import',
      'skill.write',
      'skill.delete',
      'skill.setEnabled',
      'memory.forget',
    ]);
    expect(byRisk.get('write-confirm')).toContain('doc.write');
    expect(byRisk.get('write-auto')).toContain('binder.move');
  });
});
