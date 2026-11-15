/**
 * The Kanka import on the shared preview (#293, epic #263). A campaign export is worldbuilding, not a draft: every
 * entity is offered as a codex row with its own Research page, and the tree holds only the world-history index and
 * the gallery. Nothing is written until Import, which commits one `binder.importTree`.
 */

/* lingui-set comment="The Kanka import. Interpolated values: file (the file's name), version (the Kanka version), count (entities, pictures, properties), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { KankaError, KankaImport } from '@caotang/import-kanka';
import { codexTypeOf } from '@caotang/import-kanka';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewBlock, PreviewCodexRow, PreviewNode, PreviewOption, PreviewPicture, PreviewPlan, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';

const KANKA_OPTIONS = { pictures: 'pictures' } as const;

/** The reader's refusal, in the writer's words. */
export function kankaErrorText(error: KankaError): string {
  switch (error.kind) {
    case 'not-kanka':
      return t`This is not a Kanka export. In Kanka, open Settings, choose Export, and download the JSON zip.`;
    case 'old-export':
      return error.version === ''
        ? t`This export does not say which Kanka made it, so Caotang cannot read it. Export the campaign again from Kanka 2.1 or newer.`
        : t`This export was made by Kanka ${{ version: error.version }}. Caotang reads exports from Kanka 2.1 or newer; export the campaign again.`;
    case 'empty':
      return t`This export carries no entities.`;
    case 'archive':
      return error.message;
  }
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** A Kanka campaign export in the preview, read in the Worker. */
export function kankaPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'kanka', bytes };
  let current: KankaImport | null = null;
  let loaded = false;
  let picturesOn = true;

  const readAs = async (signal: AbortSignal): Promise<KankaImport> => {
    if (current !== null) return current;
    const labels = {
      details: t`Details`,
      connections: t`Connections`,
      posts: t`Posts`,
      post: t`Post`,
      life: t`Life`,
      born: t`Born`,
      died: t`Died`,
      noDate: t`a date the export did not carry`,
      attitude: t`attitude`,
      twoWay: t`two-way`,
      year: t`year`,
      month: t`month`,
      day: t`day`,
    };
    const reply = await host.read({ kind: 'read', reader: 'kanka', labels }, signal);
    if (reply.kind !== 'kanka') throw new Error(t`It is not a Kanka import.`);
    if (!reply.result.ok) throw new Error(kankaErrorText(reply.result.error));
    current = reply.result.value;
    return reply.result.value;
  };

  const pictures = (): PreviewPicture[] => {
    const read = current;
    if (read === null) return [];
    return read.assets.flatMap((asset) => {
      const data = read.assetData.get(asset.ref);
      if (data === undefined) return [];
      return [{ ref: asset.ref, name: asset.name ?? asset.ref, bytes: data.length, data: () => data }];
    });
  };

  const options = (): PreviewOption[] => {
    const shown = pictures();
    if (shown.length === 0) return [];
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    const size = formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10));
    const count = shown.length;
    return [{ id: KANKA_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: picturesOn, detail: t`About ${size} MB.` }];
  };

  /** The two Research documents the export makes beside the codex pages, titled in the writer's language. */
  const documents = (): { title: string; body: string }[] => {
    const read = current;
    if (read === null) return [];
    const named: { title: string; body: string }[] = [];
    if (read.history !== null) {
      const title = t`World history`;
      named.push({ title, body: `# ${title}\n\n${read.history.body}` });
    }
    if (read.gallery !== null) {
      const title = t`Campaign gallery`;
      named.push({ title, body: `# ${title}\n\n${read.gallery.body}` });
    }
    return named;
  };

  const plan = (): PreviewPlan => {
    const blocks: PreviewBlock[] = [];
    const tree: PreviewNode[] = [];
    let words = 0;
    for (const [index, doc] of documents().entries()) {
      const start = blocks.length;
      for (const line of doc.body.split('\n')) {
        if (line.trim() === '') continue;
        if (line.startsWith('#')) blocks.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') });
        else if (line.startsWith('![')) blocks.push({ kind: 'image', text: line });
        else blocks.push({ kind: 'para', text: line });
        words += wordsIn(line);
      }
      tree.push({
        id: `kanka-doc-${index}`,
        // Matter, so the preview offers where it goes; a campaign export's indexes belong in Research.
        role: 'back',
        title: doc.title,
        startBlock: start,
        endBlock: Math.max(start, blocks.length - 1),
        words: wordsIn(doc.body),
        body: doc.body,
        place: 'research',
      });
    }
    const read = current;
    return {
      blocks,
      markers: [],
      tree,
      counts: { words, parts: 0, chapters: 0, scenes: tree.length, images: picturesOn ? (read?.assets.length ?? 0) : 0, comments: 0, footnotes: 0 },
      losses: (read?.losses ?? []).map((loss) => ({ message: loss.message ?? loss.code, ...(loss.count === undefined ? {} : { count: loss.count }) })),
      flags: [],
    };
  };

  return {
    fileName,
    title: t`Import “${{ file: fileName }}”`,
    readOnly: true,
    picturesOption: KANKA_OPTIONS.pictures,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs(signal);
      loaded = true;
    },
    prepare: async (_settings, signal) => {
      picturesOn = _settings.options[KANKA_OPTIONS.pictures] ?? true;
      await readAs(signal);
      loaded = true;
    },
    prepared: () => loaded,
    dispose: () => host.dispose(),
    chips: () => [],
    options,
    plan,
    pictures,
    metadata: () => {
      const read = current;
      return read === null || read.campaign === '' ? {} : { title: read.campaign };
    },
    codexRows: (): PreviewCodexRow[] => {
      const read = current;
      if (read === null) return [];
      return read.entities.flatMap((entity, index) => {
        const page = read.pages[index];
        if (page === undefined) return [];
        const keywords = read.keywords.get(entity.id) ?? [];
        return [{
          id: `kanka-entity-${entity.id}`,
          name: entity.name,
          type: codexTypeOf(entity.module),
          ...(page.description === '' ? {} : { description: page.description }),
          ...(keywords.length === 0 ? {} : { keywords }),
          ...(entity.isPrivate ? { includePolicy: 'manual' } : {}),
          page: { title: page.title, body: page.body },
          preferPage: true,
        }];
      });
    },
    // The codex pages are not tree nodes, so the scan reads them here with the names and the keywords.
    scanExtra: (): ScanExtra[] => {
      const read = current;
      if (read === null) return [];
      const label = t`Codex pages`;
      return [
        ...read.pages.map((page) => ({ label, text: page.body })),
        ...read.entities.map((entity) => ({ label: t`Character`, text: entity.name })),
        ...[...read.keywords.values()].map((words) => ({ label: t`Keywords`, text: words.join(', ') })),
      ];
    },
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const entities = read.entities.length;
      const characters = read.entities.filter((entity) => codexTypeOf(entity.module) === 'character').length;
      const carried = [plural(entities, { one: '# entity is offered as a codex entry with its own Research page', other: '# entities are offered as codex entries with their own Research pages' })];
      if (characters > 0) carried.push(plural(characters, { one: '# of them is a character', other: '# of them are characters' }));
      if (read.privateEntities > 0) {
        const privateCount = read.privateEntities;
        carried.push(plural(privateCount, { one: '# private entity is kept manual, so it is never pulled into a prompt by detection', other: '# private entities are kept manual, so they are never pulled into a prompt by detection' }));
      }
      if (read.history !== null) carried.push(t`The events and calendar dates became one World history page.`);
      if (read.gallery !== null) carried.push(t`The gallery pictures no entity uses became one Campaign gallery page.`);
      lists.push({ heading: t`Kanka`, label: t`What the campaign carried`, lines: carried });

      const approximated: string[] = [];
      const attributes = read.entities.reduce((sum, entity) => sum + entity.attributes.length, 0);
      const relations = read.entities.reduce((sum, entity) => sum + entity.relations.length, 0);
      const posts = read.entities.reduce((sum, entity) => sum + entity.posts.length, 0);
      if (attributes > 0) approximated.push(plural(attributes, { one: '# property is written as text on its page, not as a field', other: '# properties are written as text on their pages, not as fields' }));
      if (relations > 0) approximated.push(plural(relations, { one: '# connection is written as text on its page, not as a typed relation', other: '# connections are written as text on their pages, not as typed relations' }));
      if (posts > 0) approximated.push(plural(posts, { one: '# post became a section of its page', other: '# posts became sections of their pages' }));
      if (read.assets.length > 0) {
        const pictureCount = read.assets.length;
        approximated.push(plural(pictureCount, { one: '# picture is in its page’s text, not attached to the codex entry', other: '# pictures are in their pages’ text, not attached to the codex entries' }));
      }
      if (read.unresolvedMentions > 0) {
        const mentions = read.unresolvedMentions;
        approximated.push(plural(mentions, { one: '# mention names an entity the export does not carry', other: '# mentions name entities the export does not carry' }));
      }
      if (approximated.length > 0) lists.push({ heading: t`Kanka`, label: t`What was approximated`, lines: approximated });

      const dropped: string[] = [];
      const scripts = read.dropped.scripts;
      const styles = read.dropped.styles;
      const media = read.dropped.media;
      const unsafeLinks = read.dropped.unsafeLinks;
      const svg = read.refusedSvg;
      const missing = read.missingPictures;
      if (scripts > 0) dropped.push(plural(scripts, { one: '# script was removed', other: '# scripts were removed' }));
      if (styles > 0) dropped.push(plural(styles, { one: '# stylesheet was removed', other: '# stylesheets were removed' }));
      if (media > 0) dropped.push(plural(media, { one: '# audio or video player was removed', other: '# audio or video players were removed' }));
      if (unsafeLinks > 0) dropped.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
      if (svg > 0) dropped.push(plural(svg, { one: '# SVG picture was refused, because it can carry script', other: '# SVG pictures were refused, because they can carry script' }));
      if (missing > 0) dropped.push(plural(missing, { one: '# picture the export names is not in the zip', other: '# pictures the export names are not in the zip' }));
      if (dropped.length > 0) lists.push({ heading: t`Kanka safety`, label: t`What the import removed`, lines: dropped });

      if (read.remoteImages.length > 0) {
        const remote = read.remoteImages.length;
        lists.push({ heading: t`Remote pictures`, label: t`What was not downloaded`, lines: [plural(remote, { one: '# picture on the internet was not downloaded', other: '# pictures on the internet were not downloaded' })] });
      }
      return lists;
    },
    importLabel: () => {
      const rows = current?.entities.length ?? 0;
      return rows === 0 ? t`Import` : plural(rows, { one: 'Import # entry', other: 'Import # entries' });
    },
  };
}
