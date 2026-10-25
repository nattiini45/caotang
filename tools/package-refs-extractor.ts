/**
 * The custom extractor that pulls package `MessageRef` ids into the app catalogue
 * ([i18n.md §3.2](docs/architecture/i18n.md), I7).
 *
 * A package has no Lingui macro transform and must not depend on one. It writes its English
 * template in an object literal beside the stable id:
 *
 * ```ts
 * { id: 'coherence.timeline.orderDrift', message: '…{earlyTitle}…', values: { earlyTitle: early.title } }
 * ```
 *
 * This extractor reads those literals from files whose first `MARKER_WINDOW` characters (4,000)
 * carry `// i18n: package-refs`. The
 * marker keeps every other `{ id, message }` shape (a load notice, a protocol frame) out of the
 * catalogue. A literal with `values` gets a translator comment, which the hygiene guard requires
 * for every message with values (§8.2).
 */

import type { ExtractorType } from '@lingui/conf';
import ts from 'typescript';

/** Opt-in marker: a package file is scanned for refs only when this appears in its first 4,000 characters. */
export const PACKAGE_REFS_MARKER = '// i18n: package-refs';

const MARKER_WINDOW = 4000;

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(node)) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return undefined;
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of node.properties) {
    if (propertyName(member) === name) return (member as ts.PropertyAssignment).initializer;
  }
  return undefined;
}

function valueNames(node: ts.Expression | undefined): string[] {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return [];
  const names: string[] = [];
  for (const member of node.properties) {
    const name = propertyName(member);
    if (name !== undefined) names.push(name);
  }
  return names;
}

function extract(filename: string, code: string, onMessageExtracted: Parameters<ExtractorType['extract']>[2]): void {
  if (!code.slice(0, MARKER_WINDOW).includes(PACKAGE_REFS_MARKER)) return;
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = stringValue(property(node, 'id'));
      const message = stringValue(property(node, 'message'));
      if (id !== undefined && message !== undefined) {
        const names = valueNames(property(node, 'values'));
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        onMessageExtracted({
          id,
          message,
          ...(names.length === 0 ? {} : { comment: `Interpolated values: ${names.join(', ')}` }),
          origin: [filename, start.line + 1, start.character + 1],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** `lingui.config.ts` adds this after the default extractor; it matches only marked package sources. */
export const packageRefsExtractor: ExtractorType = {
  match(filename) {
    return /(?:^|[\\/])packages[\\/](?:harness|coherence|bus|store|dialogue)[\\/]src[\\/].*\.ts$/.test(filename);
  },
  extract(filename, code, onMessageExtracted) {
    extract(filename, code, onMessageExtracted);
  },
};
