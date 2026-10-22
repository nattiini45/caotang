/**
 * The refusals this package throws. Every one is thrown **before** anything is reserved, queued or written, so a caller
 * that catches one has nothing to undo.
 *
 * Each refusal is an {@link ApplyRefusal} carrying the bus's own `CommandError`: an apply that throws it is refused
 * cleanly, with the code and the corrective hint given here, and the bus writes no undo group and no activity row
 * (command-bus.md §7). Until the bus had that channel, every one reached the caller as `internal`, and two of them were
 * the KNOWN GAPs in test/exporter.test.ts. Each one is still an `Error` with its message intact, so a caller outside the
 * bus reads them the same way it did before.
 */

import { ApplyRefusal, refusal } from '@caotang/bus';

import { EXPORT_FORMATS, type ExportFormat } from './types.js';

export class UnknownExportFormatError extends ApplyRefusal {
  constructor(format: string) {
    super(
      refusal(
        'invalid-params',
        `"${format}" is not an export format in this build. The formats are ${EXPORT_FORMATS.join(', ')}. Nothing was compiled or written.`,
        { target: 'format', correctiveHint: `pass one of ${EXPORT_FORMATS.join(', ')}` },
      ),
    );
    this.name = 'UnknownExportFormatError';
  }
}

/**
 * The name each media format goes by in the Compile dialog, so a refusal names what the writer picked and not its file id
 * (the dialog's own labels, lowercased for a sentence). A format with no name here is named by its id.
 */
const MEDIA_FORMAT_NAMES: Readonly<Record<string, string>> = {
  fountain: 'the Fountain script',
  fdx: 'the Final Draft file',
  'ink-json': 'the Ink story',
  'dialogue-csv': 'the dialogue table',
  'shot-list-csv': 'the shot list',
  'dialogue-xlsx': 'the dialogue table',
  'shot-list-xlsx': 'the shot list',
  'contact-sheet-pdf': 'the contact sheet',
  promptpack: 'the prompt pack',
};

/**
 * A media compile a gate refused: a dialogue table with a row that has no line id, an Ink story that does
 * not compile, a prompt pack with a row the vendor would refuse, or a selection with nothing of the format's
 * kind in it. Thrown before anything is reserved, so nothing is written. `reasons` is one line per problem,
 * for the writer to fix; the message is the same lines joined.
 */
export class MediaRefusedError extends ApplyRefusal {
  readonly reasons: readonly string[];

  constructor(format: string, reasons: readonly string[]) {
    super(
      refusal('invalid-params', `this compile as ${MEDIA_FORMAT_NAMES[format] ?? format} is refused: ${reasons.join('; ')}. Nothing was compiled or written.`, {
        target: 'selection',
        correctiveHint: 'fix the problems the message names, then compile again',
      }),
    );
    this.name = 'MediaRefusedError';
    this.reasons = [...reasons];
  }
}

/** A binary format asked of the bus with no byte binding to hold the artifact. */
export class ExportUnavailableError extends ApplyRefusal {
  constructor(format: ExportFormat) {
    super(
      refusal(
        'invalid-params',
        `"${format}" is a binary artifact and this project has no byte binding to store it in (ArtifactFs holds strings only). Nothing was compiled or written. Compile it for download through the exporter instead, or bind a byte store.`,
        {
          target: 'format',
          correctiveHint: 'compile as md or txt, which are text, or attach a project folder, which gives the project a byte store',
        },
      ),
    );
    this.name = 'ExportUnavailableError';
  }
}

/**
 * An EPUB with no persistent identifier on record. EPUB 3.3 §5.5.2 asks that the
 * identifier survive every re-pack, so it is never derived from anything the project
 * can change: a value hashed from the project id moves when a recovery reassigns that
 * id, and a retailer would then see a new book. The compile is refused until the host
 * supplies a stored one through the metadata seam (epub-metadata.md).
 *
 * The hint names what the caller can do from where it stands. Both hosts record the
 * identifier when a project opens, so a caller that has none can compile another format
 * now, or ask the writer to open the project in Caotang, which records one (the MCP
 * server's tools cannot set it).
 */
export class NoPersistentIdentifierError extends ApplyRefusal {
  constructor() {
    super(
      refusal(
        'invalid-params',
        'this EPUB has no persistent identifier on record, and an EPUB needs one that does not change between re-packs (epub-metadata.md; EPUB 3.3 §5.5.2). Nothing was compiled or written.',
        {
          target: 'format',
          correctiveHint:
            'compile as md, txt or docx now, or ask the writer to open the project in Caotang, which records an identifier when it opens, and then compile the EPUB again',
        },
      ),
    );
    this.name = 'NoPersistentIdentifierError';
  }
}

export class UnknownRecipeError extends ApplyRefusal {
  constructor(name: string, known: readonly string[]) {
    super(
      refusal(
        'not-found',
        `there is no export recipe named "${name}" (known: ${known.length === 0 ? 'none' : known.map((n) => `"${n}"`).join(', ')}). Nothing was compiled or written.`,
        {
          target: name,
          correctiveHint:
            known.length === 0
              ? 'no recipe is saved yet; compile without recipeName to export the manuscript as it stands'
              : `name one of the saved recipes: ${known.map((n) => `"${n}"`).join(', ')}`,
        },
      ),
    );
    this.name = 'UnknownRecipeError';
  }
}

export class InvalidRecipeError extends ApplyRefusal {
  constructor(reason: string) {
    super(
      refusal('invalid-params', `the export recipe is not valid: ${reason}. It was not saved.`, {
        target: 'recipe',
        correctiveHint: 'fix the recipe, then save it again',
      }),
    );
    this.name = 'InvalidRecipeError';
  }
}

/**
 * A selection naming a node the tree does not hold. The recipe path refuses a node it does not know as `not-found`
 * (descriptors-project.ts), and the selection path agrees: an id that resolves to nothing would compile a
 * title-page-only artifact that reports success, which is the outcome the bus refuses an *empty* list to prevent. The
 * refusal names every id that could not be resolved so the writer or agent can correct them all at once.
 */
export class UnknownSelectionNodeError extends ApplyRefusal {
  constructor(ids: readonly string[]) {
    super(
      refusal(
        'not-found',
        `the selection names ${ids.length === 1 ? 'a node' : 'nodes'} the project does not hold: ${ids.map((id) => `"${id}"`).join(', ')}. Nothing was compiled or written.`,
        {
          target: 'includeRootIds',
          correctiveHint: 'name nodes that are in the project (recovery reassigns ids after an import, so read them again), or compile without a selection for the whole manuscript',
        },
      ),
    );
    this.name = 'UnknownSelectionNodeError';
  }
}

/**
 * The bus compiles synchronously (command-bus.md A2), and the name reservation it
 * needs is only possible once `exports/` has been listed. Dispatching before that
 * is a caller bug, and it is refused rather than reserving a name blind. It stays a plain
 * error: it is a defect in the caller's order of calls, not a refusal of the writer's request.
 */
export class ExportNotReadyError extends Error {
  constructor() {
    super(
      'the exporter has not listed exports/ yet, so it cannot reserve an output name without risking an overwrite. Await exporter.ready() before dispatching an export. Nothing was compiled or written.',
    );
    this.name = 'ExportNotReadyError';
  }
}
