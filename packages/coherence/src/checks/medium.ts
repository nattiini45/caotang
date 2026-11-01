// i18n: package-refs
/**
 * Cross-medium checks — [coherence.md §5.1](../../../../docs/architecture/coherence.md): `medium.speaker-parity`.
 *
 * A screenplay scene and a dialogue container are compared only when the writer paired them
 * (`SceneMeta.dialogueContainer`), the one rule every check here keeps: nothing is guessed from a title or a likeness of
 * content. What is compared is speakers and nothing else: the characters the scene's cues name against the characters the
 * container's `Name:` lines name, both resolved against the codex. A branch may rightly add or drop a line, so every finding
 * is information, and none speaks for the lines or their meaning.
 */

import { characterCueNames, type LocatedElement } from '@caotang/screenplay';

import { entryForCue, isScreenplayDocument } from '../cues.js';
import type { Evidence } from '../model.js';
import { headEvidence, type ScannedScene } from '../scope.js';

import { groupKey, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';
import { factsOf, passageAt } from './script.js';

const CHECK_ID = 'medium.speaker-parity';
const SCOPE_SENTENCE = 'Only speakers are compared, not lines or meaning.';

/** One character of one medium: the spelling used, the codex character it resolves to, and a stable key for both. */
interface Speaker {
  readonly name: string;
  readonly entryId?: string;
  readonly key: string;
  /** The cue that names the speaker, on the screenplay side. */
  readonly element?: LocatedElement;
}

/** A name without case, punctuation or runs of spaces, so `MARISOL`, `Marisol.` and `marisol` are one spelling. */
function spellingOf(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/u)
    .filter((word) => word !== '')
    .join(' ');
}

function speakerOf(name: string, entryId: string | undefined, element?: LocatedElement): Speaker {
  const key = entryId ?? `name:${spellingOf(name)}`;
  return { name, key, ...(entryId === undefined ? {} : { entryId }), ...(element === undefined ? {} : { element }) };
}

/** The characters a screenplay scene cues, once each, in cue order. A cue resolves when it names a codex character. */
function screenplaySpeakers(input: CheckInput, scene: ScannedScene): Speaker[] {
  const speakers = new Map<string, Speaker>();
  for (const element of factsOf(input, scene).elements) {
    if (element.type !== 'character') continue;
    const [name] = characterCueNames([element]);
    if (name === undefined) continue;
    const entry = entryForCue(input.entries, name);
    const speaker = speakerOf(name, entry?.type === 'character' ? entry.id : undefined, element);
    if (!speakers.has(speaker.key)) speakers.set(speaker.key, speaker);
  }
  return [...speakers.values()];
}

/** Whether every word of the shorter spelling is a word of the longer: `Marisol` against `Marisol Vega`. */
function nearSpellings(a: Speaker, b: Speaker): boolean {
  const x = new Set(spellingOf(a.name).split(' ').filter((word) => word !== ''));
  const y = new Set(spellingOf(b.name).split(' ').filter((word) => word !== ''));
  if (x.size === 0 || y.size === 0) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((word) => large.has(word));
}

interface Comparison {
  /** Two spellings the codex does not treat alike, paired because one reads as part of the other. */
  readonly differing: readonly (readonly [Speaker, Speaker])[];
  readonly screenplayOnly: readonly Speaker[];
  readonly dialogueOnly: readonly Speaker[];
}

/**
 * Pairs the two casts. The same codex character, or the same spelling, is a match. Of what is left, a screenplay name and a
 * dialogue name that read as one name are paired when each is the other's only candidate and the codex knows at least one of
 * them; the pair is the "Marisol" and "Marisol Vega" case. Everything else is on one side only.
 */
function compare(screenplay: readonly Speaker[], dialogue: readonly Speaker[]): Comparison {
  const left = [...screenplay];
  const right = [...dialogue];
  for (const s of [...left]) {
    const at = right.findIndex((d) => d.key === s.key);
    if (at < 0) continue;
    left.splice(left.indexOf(s), 1);
    right.splice(at, 1);
  }
  const differing: (readonly [Speaker, Speaker])[] = [];
  for (const s of [...left]) {
    const near = right.filter((d) => nearSpellings(s, d));
    const only = near[0];
    if (near.length !== 1 || only === undefined) continue;
    if (left.filter((other) => nearSpellings(other, only)).length !== 1) continue;
    if (s.entryId === undefined && only.entryId === undefined) continue;
    differing.push([s, only]);
    left.splice(left.indexOf(s), 1);
    right.splice(right.indexOf(only), 1);
  }
  return { differing, screenplayOnly: left, dialogueOnly: right };
}

/** What the codex makes of a differing pair, in words. */
function codexVerdict(screenplay: Speaker, dialogue: Speaker, entryName: (id: string) => string): string {
  if (screenplay.entryId !== undefined && dialogue.entryId !== undefined) {
    return `the codex has them as two characters, "${entryName(screenplay.entryId)}" and "${entryName(dialogue.entryId)}"`;
  }
  return screenplay.entryId !== undefined ? "the codex knows only the screenplay's spelling" : "the codex knows only the dialogue's spelling";
}

/**
 * `medium.speaker-parity`: for each screenplay scene the writer paired with a dialogue container, the characters its cues name
 * against the characters the container's lines name. Three kinds of finding, all information:
 *  - `speaker-differs`: a screenplay spelling and a dialogue spelling that read as one name, where the codex knows only one of
 *    them or knows them as two characters;
 *  - `speaker-screenplay-only`: a character the scene cues and the container does not name;
 *  - `speaker-dialogue-only`: a character the container names and the scene does not cue. A container no scene points at is
 *    never read, which is the normal shape of a branch with no flat script.
 *
 * The group is the scene, the container and the character, never a position, so a dismissal survives an edit to the text
 * around the cue. The run note says how many scenes were compared and how many were not.
 */
export function checkSpeakerParity(input: CheckInput): CheckOutput {
  const speakersByContainer = input.dialogue?.speakersByContainer;
  if (speakersByContainer === undefined) {
    return { drafts: [], notes: ['speaker parity not evaluated: the dialogue speakers were not supplied for this run'] };
  }
  const entryName = (id: string): string => input.entries.find((entry) => entry.id === id)?.name ?? id;
  const drafts: DraftFinding[] = [];
  let linked = 0;
  let unlinked = 0;
  let unused = 0;
  for (const scene of input.scenes) {
    if (scene.meta.dialogueContainer === undefined) {
      if (isScreenplayDocument(scene.kind)) unlinked += 1;
      continue;
    }
    const container = speakersByContainer.get(scene.meta.dialogueContainer);
    // A link to a container the run did not read (deleted, archived, outside the manuscript) or on a scene that is not a
    // screenplay compares nothing, and the note counts it.
    if (container === undefined || !isScreenplayDocument(scene.kind)) {
      unused += 1;
      continue;
    }
    linked += 1;
    const containerId = scene.meta.dialogueContainer;
    const group = (attribute: string): string => groupKey(`${scene.docId}|${containerId}`, attribute);
    const { differing, screenplayOnly, dialogueOnly } = compare(
      screenplaySpeakers(input, scene),
      container.map((speaker) => speakerOf(speaker.name, speaker.entryId)),
    );
    const cue = (speaker: Speaker): Evidence => (speaker.element === undefined ? headEvidence(scene) : passageAt(scene, speaker.element.range.from, speaker.element.range.to));
    for (const [s, d] of differing) {
      drafts.push({
        checkId: CHECK_ID,
        type: 'speaker-differs',
        severity: 'info',
        factGroup: group(`differs:${s.key}~${d.key}`),
        evidence: [cue(s)],
        message: `The screenplay scene "${scene.title}" cues "${s.name}", but its linked dialogue says "${d.name}"; ${codexVerdict(s, d, entryName)}. ${SCOPE_SENTENCE}`,
        messageRef:
          s.entryId !== undefined && d.entryId !== undefined
            ? {
                id: 'coherence.medium.speakerDiffersTwoEntries',
                message:
                  'The screenplay scene "{sceneTitle}" cues "{screenplayName}", but its linked dialogue says "{dialogueName}"; the codex has them as two characters, "{screenplayEntry}" and "{dialogueEntry}". Only speakers are compared, not lines or meaning.',
                values: {
                  sceneTitle: scene.title,
                  screenplayName: s.name,
                  dialogueName: d.name,
                  screenplayEntry: entryName(s.entryId),
                  dialogueEntry: entryName(d.entryId),
                },
              }
            : {
                id: s.entryId !== undefined ? 'coherence.medium.speakerDiffersScreenplayOnly' : 'coherence.medium.speakerDiffersDialogueOnly',
                message:
                  s.entryId !== undefined
                    ? 'The screenplay scene "{sceneTitle}" cues "{screenplayName}", but its linked dialogue says "{dialogueName}"; the codex knows only the screenplay\'s spelling. Only speakers are compared, not lines or meaning.'
                    : 'The screenplay scene "{sceneTitle}" cues "{screenplayName}", but its linked dialogue says "{dialogueName}"; the codex knows only the dialogue\'s spelling. Only speakers are compared, not lines or meaning.',
                values: { sceneTitle: scene.title, screenplayName: s.name, dialogueName: d.name },
              },
        expected: 'one spelling for the character in both media, or an alias in the codex that names both',
      });
    }
    for (const s of screenplayOnly) {
      drafts.push({
        checkId: CHECK_ID,
        type: 'speaker-screenplay-only',
        severity: 'info',
        factGroup: group(`screenplay-only:${s.key}`),
        evidence: [cue(s)],
        message: `The screenplay scene "${scene.title}" cues "${s.name}", but its linked dialogue has no speaker by that name. ${SCOPE_SENTENCE}`,
        messageRef: {
          id: 'coherence.medium.speakerScreenplayOnly',
          message:
            'The screenplay scene "{sceneTitle}" cues "{screenplayName}", but its linked dialogue has no speaker by that name. Only speakers are compared, not lines or meaning.',
          values: { sceneTitle: scene.title, screenplayName: s.name },
        },
        expected: 'the same cast in both media, or a dismissal saying the branch changes it on purpose',
      });
    }
    for (const d of dialogueOnly) {
      drafts.push({
        checkId: CHECK_ID,
        type: 'speaker-dialogue-only',
        severity: 'info',
        factGroup: group(`dialogue-only:${d.key}`),
        evidence: [headEvidence(scene)],
        message: `The dialogue linked to the screenplay scene "${scene.title}" has a speaker "${d.name}" that the scene does not cue. ${SCOPE_SENTENCE}`,
        messageRef: {
          id: 'coherence.medium.speakerDialogueOnly',
          message:
            'The dialogue linked to the screenplay scene "{sceneTitle}" has a speaker "{dialogueName}" that the scene does not cue. Only speakers are compared, not lines or meaning.',
          values: { sceneTitle: scene.title, dialogueName: d.name },
        },
        expected: 'the same cast in both media, or a dismissal saying the branch changes it on purpose',
      });
    }
  }
  const skipped = unused === 0 ? '' : ` (${unused} link(s) name a dialogue container that is missing, archived or not read, or sit on a scene that is not a screenplay)`;
  return {
    drafts,
    notes: [`speaker parity: ${linked} scene(s) linked, ${unlinked} scene(s) have no dialogue container link; they are not compared${skipped}`],
  };
}
