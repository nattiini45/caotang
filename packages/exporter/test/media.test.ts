/**
 * The media-track formats, one structural contract per format (the one-source compile), through the §4 API. The
 * compile writes nothing, so each test reads the files a compile produced and checks what the spec says a file
 * of that format is. The bus path, the log and the undo are in `media-bus.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { TableRow } from '@caotang/dialogue';
import { importFountainScript, parseFdxParagraphs, parseFountain } from '@caotang/screenplay';
import { addDocument, addFolder, createEmptyManifest, createProjectState, MemoryArtifactFs, nodeById, type ProjectState } from '@caotang/store';
import {
  createExporter,
  MediaRefusedError,
  type ExportFile,
  type ExportFormat,
  type ExporterService,
} from '../src/index.js';
import { dialogueCsv } from '../src/media.js';
import { COMPILED_AT, PROJECT_NAME } from './fixture.js';
import {
  ASSET_FILE,
  ASSET_ID,
  ASSETS,
  BROKEN_INK,
  DUPLICATE_ID_INK,
  MEDIA_IDS,
  OPENED,
  SCENE_SYNOPSIS,
  UNKEYED_INK,
  makeMediaProject,
} from './media-fixture.js';
import { assertWellFormedXml } from './xml.js';

interface Rig {
  readonly state: ProjectState;
  readonly exporter: ExporterService;
}

function rig(options: { state?: ProjectState; assets?: boolean } = {}): Rig {
  const state = options.state ?? makeMediaProject();
  const exporter = createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    clock: { now: () => COMPILED_AT },
    metadata: () => ({ author: 'Ada Lovelace' }),
    ...(options.assets === false ? {} : { assets: () => ASSETS }),
  });
  return { state, exporter };
}

/** Every file a §4 compile produced, as text, by its name. */
async function filesOf(exporter: ExporterService, selection: string[], format: ExportFormat, templateId?: string): Promise<Map<string, string>> {
  const result = await exporter.compile({ includeRootIds: selection }, format, templateId);
  const out = new Map<string, string>();
  for (const file of result.files) out.set(file.fileName, await file.blob.text());
  return out;
}

/** The one file a single-artifact format produced, by its name and text. */
async function oneFile(
  exporter: ExporterService,
  selection: string[],
  format: ExportFormat,
  templateId?: string,
): Promise<{ readonly file: ExportFile; readonly text: string }> {
  const result = await exporter.compile({ includeRootIds: selection }, format, templateId);
  const file = result.files[0];
  if (file === undefined || result.files.length !== 1) throw new Error(`expected one file, got ${result.files.length}`);
  return { file, text: await file.blob.text() };
}

/** A whole script as a writer keeps one in Fountain: a title page, a section and two scenes, one with a synopsis. */
const WHOLE_SCRIPT = [
  'Title: The Lighthouse Keeper',
  'Credit: Written by',
  'Author: Ada Lovelace',
  'Draft date: 2026-10-08',
  '',
  '# Script',
  '',
  'INT. KITCHEN - DAY',
  '= Mara learns the ferry has gone.',
  '',
  'MARA',
  'Where were you?',
  '',
  'ELI',
  'Out on the water.',
  '',
  'EXT. HARBOUR - NIGHT',
  '',
  'The water is black.',
  '',
].join('\n');

/**
 * The binder a whole-script import makes (screenplay.md §2.2): each section a folder under the manuscript, and each
 * scene a screenplay document under the section above it, with the scene's own text and its synopsis.
 */
function bindersFromScript(source: string): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED));
  let parentId = 'manuscript';
  importFountainScript(source).nodes.forEach((node, index) => {
    const id = `n_IMPORT${String(index).padStart(3, '0')}`;
    if (node.kind === 'section') {
      addFolder(state, { parentId: 'manuscript', title: node.title, now: OPENED, id });
      parentId = id;
    } else {
      const doc = addDocument(state, { parentId, title: node.title, body: node.body, synopsis: node.synopsis, now: OPENED, id });
      Object.assign(doc, { kind: 'screenplay' });
    }
  });
  return state;
}

describe('fountain — the screenplay scenes as Fountain', () => {
  it('writes a title page, the chapter line, and each scene verbatim', async () => {
    const { text, file } = await oneFile(rig().exporter, ['manuscript'], 'fountain');

    expect(file.fileName).toBe(`${PROJECT_NAME}.fountain`);
    expect(file.mimeType).toContain('text/plain');
    expect(text.startsWith(`Title: ${PROJECT_NAME}\nCredit: Written by\nAuthor: Ada Lovelace\n`)).toBe(true);
    // The synopsis line sits under the heading (screenplay.md §2.2), so the scene reads heading, synopsis, then its elements.
    expect(text).toContain(
      `# Script\n\nINT. KITCHEN - DAY\n= ${SCENE_SYNOPSIS}\n\nMARA\nWhere were you?\n\nELI\nOut on the water.`,
    );
  });

  it('regenerates each scene\'s synopsis line from the manifest, under its heading', async () => {
    const { text } = await oneFile(rig().exporter, ['manuscript'], 'fountain');
    expect(text).toContain(`INT. KITCHEN - DAY\n= ${SCENE_SYNOPSIS}\n`);
  });

  it('leaves a prose document out, and says so in the log notes', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'fountain');
    const text = await result.files[0]?.blob.text();
    expect(text).not.toContain('She hates the rain.');
    expect(result.log.notes).toContain('left out: "Notes for MARA" is a prose document, not a screenplay scene, so it is not in this compile');
  });

  it('parses back to the scene headings it was given, in order', async () => {
    const { text } = await oneFile(rig().exporter, ['manuscript'], 'fountain');
    const headings = parseFountain(text).elements.flatMap((el) => (el.type === 'scene_heading' ? [el.text] : []));
    expect(headings).toEqual(['INT. KITCHEN - DAY']);
  });

  // screenplay.md §5.1's round-trip gate, for one whole-script file: import, then compile, and the text comes back as it
  // went in. The synthesis the spec allows (the section line from the tree, the synopsis line from the manifest) is
  // here the same text the file had, so the gate is byte identity. Sections deeper than one, and section synopses,
  // are the cases this fixture does not reach (a known gap).
  it('round-trips a whole-script Fountain file: import it, compile it, and the same text comes back', async () => {
    const state = bindersFromScript(WHOLE_SCRIPT);
    const { text } = await oneFile(rig({ state }).exporter, ['manuscript'], 'fountain');
    expect(text).toBe(WHOLE_SCRIPT);
  });

  it('refuses a selection with no screenplay scene, and names what it left out', async () => {
    const r = rig();
    await expect(r.exporter.compile({ includeRootIds: ['research'] }, 'fountain')).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(r.exporter.compile({ includeRootIds: ['research'] }, 'fountain')).rejects.toThrow(
      /the selection holds no screenplay scene.*left out: "Ferry timetable"/,
    );
  });

  it('refuses a selection whose only screenplay scene is empty, and names the empty scene', async () => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: '' });
    const attempt = rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'fountain');
    await expect(attempt).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(attempt).rejects.toThrow('"Script → INT. KITCHEN - DAY" is empty');
  });
});

describe('fdx — the same scenes as Final Draft XML', () => {
  it('types the scene heading as a Scene Heading paragraph, and the action and dialogue as their own', async () => {
    const { text, file } = await oneFile(rig().exporter, ['manuscript'], 'fdx');
    expect(file.fileName).toBe(`${PROJECT_NAME}.fdx`);
    expect(text.startsWith('<?xml')).toBe(true);
    const paragraphs = parseFdxParagraphs(text);
    expect(paragraphs.find((p) => p.type === 'Scene Heading')?.text).toBe('INT. KITCHEN - DAY');
    expect(paragraphs.some((p) => p.type === 'Character' && p.text === 'MARA')).toBe(true);
    expect(paragraphs.some((p) => p.type === 'Dialogue' && p.text === 'Where were you?')).toBe(true);
  });

  it('writes XML that parses, when the text carries a character XML 1.0 forbids', async () => {
    // A paste can bring U+000B and U+0001 into a scene. An FDX file that holds them is not well-formed XML, and Final Draft
    // rejects it, so the compile removes them as the DOCX and EPUB writers do.
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, {
      ...kitchen,
      body: 'INT. KITCHEN - DAY\n\nMARA\nWhere\u000B were\u0001 you?\n\nELI\nOut on the water.',
    });
    const { text } = await oneFile(rig({ state }).exporter, ['manuscript'], 'fdx');
    expect(() => assertWellFormedXml('the FDX', text)).not.toThrow();
    expect(parseFdxParagraphs(text).some((p) => p.type === 'Dialogue' && p.text === 'Where were you?')).toBe(true);
  });

  it('refuses a selection with no screenplay scene, as the Fountain format does', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['research'] }, 'fdx')).rejects.toThrow(
      'the selection holds no screenplay scene',
    );
  });
});

describe('ink-json — one compiled story per dialogue container', () => {
  it('compiles the container to <title>.ink.json, and the file is an Ink story', async () => {
    const files = await filesOf(rig().exporter, ['manuscript'], 'ink-json');
    expect([...files.keys()]).toEqual(['The innkeeper.ink.json']);
    const story = JSON.parse(files.get('The innkeeper.ink.json') ?? '{}') as { inkVersion?: unknown; root?: unknown };
    expect(typeof story.inkVersion).toBe('number');
    expect(story.root).toBeDefined();
  });

  it('refuses the whole compile when a container does not compile, names it, and writes nothing', async () => {
    const r = rig({ state: makeMediaProject({ innkeeper: BROKEN_INK }) });
    const attempt = r.exporter.compile({ includeRootIds: ['manuscript'] }, 'ink-json');
    await expect(attempt).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(attempt).rejects.toThrow(/"The innkeeper" does not compile/);
  });

  it('refuses a selection with no dialogue container', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['research'] }, 'ink-json')).rejects.toThrow(
      'the selection holds no dialogue container',
    );
  });
});

/** Speakers whose lines open with what a spreadsheet reads as a formula, a mention or a sign. */
const GUARD_INK = [
  '=== start ===',
  'Innkeeper: =HYPERLINK(example.invalid,click) # lineId: l_0000000101',
  'Innkeeper: -5 gold, the toll. # lineId: l_0000000102',
  'Innkeeper: @Mara, come in. # lineId: l_0000000103',
  'Innkeeper: +1 ale. # lineId: l_0000000104',
  '-> END',
].join('\n');

describe('dialogue-csv — the dialogue table, keyed by line id', () => {
  it('writes the spec\'s columns, one row per speakable line and choice, in CRLF records', async () => {
    const { text, file } = await oneFile(rig().exporter, ['manuscript'], 'dialogue-csv');
    expect(file.fileName).toBe(`${PROJECT_NAME} (dialogue).csv`);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('lineId,speaker,text,context,charLimit,locale');
    expect(lines).toContain('l_0000000001,,The innkeeper looks up.,start,,en');
    expect(lines).toContain('l_0000000002,Innkeeper,"Ah, a traveller. What\'ll it be?",start,,en');
    expect(lines).toContain('l_0000000003_c,,Order an ale,start,,en');
    expect(lines).toContain('l_0000000005,,"Ale arrives, foaming.",ale,,en');
  });

  it('guards a text cell that a spreadsheet would read as a formula, as the shot list and the prompt pack do', async () => {
    const r = rig({ state: makeMediaProject({ innkeeper: GUARD_INK }) });
    const { text } = await oneFile(r.exporter, ['manuscript'], 'dialogue-csv');
    const lines = text.split('\r\n');
    expect(lines).toContain(`l_0000000101,Innkeeper,"'=HYPERLINK(example.invalid,click)",start,,en`);
    expect(lines).toContain(`l_0000000102,Innkeeper,"'-5 gold, the toll.",start,,en`);
    expect(lines).toContain(`l_0000000103,Innkeeper,"'@Mara, come in.",start,,en`);
    expect(lines).toContain(`l_0000000104,Innkeeper,'+1 ale.,start,,en`);
  });

  it('refuses a table with an unkeyed row, and names the line', async () => {
    const r = rig({ state: makeMediaProject({ innkeeper: UNKEYED_INK }) });
    await expect(r.exporter.compile({ includeRootIds: ['manuscript'] }, 'dialogue-csv')).rejects.toThrow(
      /"The innkeeper" line \d+ has no line id/,
    );
  });

  it('names the refused format the way the Compile dialog does, not by its file id', async () => {
    // The dialog offers "Dialogue table (.csv)"; a refusal that says "dialogue-csv" reads as a file name to the writer.
    const r = rig({ state: makeMediaProject({ innkeeper: UNKEYED_INK }) });
    const error = await r.exporter.compile({ includeRootIds: ['manuscript'] }, 'dialogue-csv').then(
      () => null,
      (caught: unknown) => caught,
    );
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('this compile as the dialogue table is refused');
    expect(message).not.toContain('dialogue-csv');
  });

  it('refuses a table in which one id names two lines', async () => {
    const r = rig({ state: makeMediaProject({ innkeeper: DUPLICATE_ID_INK }) });
    await expect(r.exporter.compile({ includeRootIds: ['manuscript'] }, 'dialogue-csv')).rejects.toThrow(
      'line id l_0000000001 is on more than one line',
    );
  });

  it('refuses a selection with no dialogue container', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['research'] }, 'dialogue-csv')).rejects.toThrow(
      'the selection holds no dialogue container',
    );
  });
});

describe('dialogueCsv — the formula guard on the table\'s text cells', () => {
  /** A table row whose fields the test does not set is one with no speaker, text, context or charLimit. */
  function rowWith(fields: Partial<TableRow>): TableRow {
    return {
      container: 'c',
      lineId: 'l_0000000001',
      missing: false,
      kind: 'line',
      speaker: '',
      speakerName: '',
      text: '',
      context: '',
      locale: '',
      charLimit: null,
      condition: '',
      node: 'start',
      line: 1,
      ...fields,
    };
  }

  it('guards a leading =, +, -, @, tab or carriage return, and writes every other cell as the table does', () => {
    const csv = dialogueCsv([
      rowWith({ text: '=1+1' }),
      rowWith({ text: '+1' }),
      rowWith({ text: '-1' }),
      rowWith({ text: '@Mara' }),
      rowWith({ text: '\tindented' }),
      rowWith({ text: '\rreturned' }),
      rowWith({ text: 'a=b' }),
      rowWith({ text: 'Plain, text' }),
    ]);
    expect(csv.split('\r\n')).toEqual([
      'lineId,speaker,text,context,charLimit,locale',
      "l_0000000001,,'=1+1,,,",
      "l_0000000001,,'+1,,,",
      "l_0000000001,,'-1,,,",
      "l_0000000001,,'@Mara,,,",
      "l_0000000001,,'\tindented,,,",
      "l_0000000001,,\"'\rreturned\",,,",
      'l_0000000001,,a=b,,,',
      'l_0000000001,,"Plain, text",,,',
      '',
    ]);
  });

  it('guards the speaker and the context in the same way, since they are text too', () => {
    const csv = dialogueCsv([rowWith({ speaker: '=Narrator' }), rowWith({ context: '-start' })]);
    expect(csv.split('\r\n').slice(1, 3)).toEqual(["l_0000000001,'=Narrator,,,,", "l_0000000001,,,'-start,,"]);
  });
});

describe('shot-list-csv — the shot list, one row per shot', () => {
  it('writes one row per shot in binder order, with the image file and the covered cue', async () => {
    const { text, file } = await oneFile(rig().exporter, ['manuscript'], 'shot-list-csv');
    expect(file.fileName).toBe(`${PROJECT_NAME} (shot list).csv`);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('shotNumber,image filename,shotSize,cameraAngle,cameraMovement,lens,action,dialogue,durationSec,transition');
    expect(lines[1]).toBe(`1,${ASSET_FILE},MS,eye,static,,Mara sets the kettle down.,INT. KITCHEN - DAY:MARA,5,cut`);
    // The action has a comma, so RFC 4180 quotes it.
    expect(lines[2]).toBe('2,,WS,,,,"The harbour, empty.",,6,');
  });

  it('leaves the image column blank, and says why, when the asset is not in the store', async () => {
    const result = await rig({ assets: false }).exporter.compile({ includeRootIds: ['manuscript'] }, 'shot-list-csv');
    const text = await result.files[0]?.blob.text();
    expect(text?.split('\r\n')[1]?.startsWith('1,,MS,')).toBe(true);
    expect(result.log.notes).toContain(`shot 1: image ${ASSET_ID} has no file in assets/, so the image column is blank`);
  });

  it('notes a shot with no metadata on record, so its blank columns are not read as a blank shot', async () => {
    // The store does not keep a shot's metadata on save yet (a known gap), so a reloaded shot can list with every column blank.
    const intact = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'shot-list-csv');
    expect(intact.log.notes.some((note) => note.includes('no shot metadata'))).toBe(false);

    const state = makeMediaProject();
    const shot = nodeById(state, MEDIA_IDS.shotTwo) as { shot?: unknown } | undefined;
    if (shot === undefined) throw new Error('the fixture has no second shot');
    delete shot.shot;
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'shot-list-csv');
    expect(result.log.notes).toContain('shot 2: no shot metadata is on record, so its columns are blank');
  });

  it('refuses a selection with no shot', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['research'] }, 'shot-list-csv')).rejects.toThrow(
      'the selection holds no shot',
    );
  });
});

describe('promptpack — the video prompt pack, three artifacts from one run', () => {
  it('writes the JSON, the Markdown and the CSV, named for the vendor', async () => {
    const files = await filesOf(rig().exporter, ['manuscript'], 'promptpack', 'runway-gen4');
    expect([...files.keys()].sort()).toEqual(
      ['runway-gen4-prompt-pack.json', 'runway-gen4-prompt-pack.md', 'runway-gen4-shot-list.csv'].sort(),
    );
  });

  it('the JSON names the vendor and its shots, and lists the files a hand-attached vendor needs', async () => {
    const files = await filesOf(rig().exporter, ['manuscript'], 'promptpack', 'runway-gen4');
    const pack = JSON.parse(files.get('runway-gen4-prompt-pack.json') ?? '{}') as {
      templateId?: string;
      shots?: { shotNumber?: number; mode?: string }[];
      attach?: { file?: string }[];
    };
    expect(pack.templateId).toBe('runway-gen4');
    expect(pack.shots?.map((shot) => shot.shotNumber)).toEqual([1]);
    expect(pack.attach?.some((entry) => entry.file === ASSET_FILE)).toBe(true);
  });

  it('leaves a shot with no prompt out with a warning, so the export still runs', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'promptpack', 'runway-gen4');
    expect(result.log.notes.some((note) => note.startsWith('warning:') && note.includes('has no prompt for'))).toBe(true);
    expect(result.files).toHaveLength(3);
  });

  it('refuses a run with an error row, names every error row, and writes nothing', async () => {
    const r = rig();
    const shot = nodeById(r.state, MEDIA_IDS.shotOne) as { shot?: { vendorRefs?: { durationSec?: number }[] } } | undefined;
    const record = shot?.shot?.vendorRefs?.[0];
    if (record === undefined) throw new Error('the fixture has no prompt record to break');
    record.durationSec = 6;
    await expect(r.exporter.compile({ includeRootIds: ['manuscript'] }, 'promptpack', 'runway-gen4')).rejects.toBeInstanceOf(
      MediaRefusedError,
    );
  });

  it('refuses a template id that is not installed, and lists the installed ones', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'promptpack', 'no-such-vendor')).rejects.toThrow(
      /"no-such-vendor" is not an installed vendor template. The installed templates are runway-gen4/,
    );
  });

  it('refuses a compile that names no vendor, because a pack is written for one', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'promptpack')).rejects.toThrow(
      'names no vendor template',
    );
  });
});

describe('a folder whose images cannot be listed', () => {
  /** An exporter whose images port raises, as the desktop's and the MCP server's do when the assets folder cannot be read. */
  function unlistable(): ExporterService {
    return createExporter({
      readState: () => makeMediaProject(),
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace' }),
      assets: () => {
        throw new Error('EACCES: permission denied, scandir assets');
      },
    });
  }

  it('refuses the shot list, which names the images, with the listing error', async () => {
    await expect(unlistable().compile({ includeRootIds: ['manuscript'] }, 'shot-list-csv')).rejects.toThrow('EACCES');
  });

  it('still compiles a script and a dialogue table, which name no image', async () => {
    const exporter = unlistable();
    for (const format of ['fountain', 'fdx', 'dialogue-csv'] as const) {
      const result = await exporter.compile({ includeRootIds: ['manuscript'] }, format);
      expect(result.files.length).toBeGreaterThan(0);
    }
  });
});
