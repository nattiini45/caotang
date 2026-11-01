/**
 * The package functions the import preview's model needs (model.ts `PreviewHelpers`). This file is imported by ImportPreviewHost, which
 * is in the entry, so the lazy dialog chunk reaches `@caotang/harness` and `@caotang/store` only through the props it is given and the
 * bundler has no package root to split off the entry.
 */

import { importScanSentence, scanImport } from '@caotang/harness';
import { keepsImportedBody } from '@caotang/store';

import type { PreviewHelpers } from './model.js';

export const PREVIEW_HELPERS: PreviewHelpers = { scanImport, importScanSentence, keepsImportedBody };
