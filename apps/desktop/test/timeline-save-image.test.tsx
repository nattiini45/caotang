/**
 * The timeline's Save image (timeline.md §8): a labelled control in the toolbar, and an action that draws the timeline with the
 * exporter's own SVG, rasterizes it and hands the PNG to the download. The suite runs in Node, which has no canvas, so the
 * rasterizer and the download are the action's seams: the control is read from its rendered markup and its element tree, and the
 * action runs against stand-ins for the two browser-only steps.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { renderTimelineSvg } from '@caotang/exporter';
import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';

import { initialViewState } from '../src/app/timeline-model.js';
import { saveTimelineImage, timelineImageName, type TimelineImageDeps } from '../src/app/timeline-image.js';
import { TimelineControls, type TimelineControlsProps } from '../src/components/timeline/TimelineControls.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const SCENE = 'n_SCENE00001';

beforeEach(() => activateEnglish());

function project(name = 'Story: Book'): ProjectState {
  const state = createProjectState(createEmptyManifest(name, NOW), { now: NOW });
  addDocument(state, { id: SCENE, parentId: 'manuscript', title: 'Arrival', body: 'Arrival is written here.', now: NOW });
  state.coherence = { ...emptyCoherenceFile(), sceneMeta: { [SCENE]: { dayOffset: 0 } } } as CoherenceFile;
  return state;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function deps(overrides: Partial<TimelineImageDeps> = {}): { deps: TimelineImageDeps; rasterize: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> } {
  const rasterize = vi.fn(async (_svg: string) => new Blob([PNG_BYTES], { type: 'image/png' }));
  const download = vi.fn();
  return {
    rasterize,
    download,
    deps: { exporter: async () => ({ renderTimelineSvg, rasterizeSvgToPng: rasterize }), download, ...overrides },
  };
}

function controlsProps(extra: Partial<TimelineControlsProps> = {}): TimelineControlsProps {
  return {
    view: initialViewState(1),
    agenda: false,
    scheduled: 1,
    total: 1,
    scopes: [],
    scope: null,
    onAxis: () => undefined,
    onZoom: () => undefined,
    onGroupBy: () => undefined,
    onScope: () => undefined,
    onCompress: () => undefined,
    onOverlay: () => undefined,
    onFollow: () => undefined,
    onAgenda: () => undefined,
    onSaveImage: () => undefined,
    savingImage: false,
    ...extra,
  };
}

/** Every element of a rendered tree, depth first. The controls hold no hooks, so the component can be called as a function. */
function elementsOf(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) node.forEach((child) => elementsOf(child as ReactNode, out));
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    elementsOf(node.props['children'] as ReactNode, out);
  }
  return out;
}

describe('the Save image control', () => {
  it('is a real button in the timeline toolbar, named "Save image"', () => {
    const markup = renderToStaticMarkup(<I18nProvider i18n={i18n}><TimelineControls {...controlsProps()} /></I18nProvider>);
    expect(markup).toMatch(/<button type="button" class="tl-save" data-testid="timeline-save-image" aria-busy="false">Save image<\/button>/);
    expect(markup.indexOf('role="toolbar"')).toBeLessThan(markup.indexOf('timeline-save-image'));
  });

  it('is disabled and busy while a picture is being drawn', () => {
    const markup = renderToStaticMarkup(<I18nProvider i18n={i18n}><TimelineControls {...controlsProps({ savingImage: true })} /></I18nProvider>);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"|<button[^>]*aria-busy="true"[^>]*disabled=""/);
  });

  it('calls the view\'s save action when it is pressed', () => {
    const onSaveImage = vi.fn();
    const button = elementsOf(TimelineControls(controlsProps({ onSaveImage }))).find((element) => element.props['data-testid'] === 'timeline-save-image');
    expect(button).toBeDefined();
    (button?.props['onClick'] as () => void)();
    expect(onSaveImage).toHaveBeenCalledTimes(1);
  });
});

describe('saving the timeline image', () => {
  it('draws the exporter\'s SVG for the selection, rasterizes it and downloads the PNG', async () => {
    const run = deps();
    const outcome = await saveTimelineImage({ state: project(), scopeId: null }, run.deps);
    expect(outcome).toEqual({ ok: true, filename: 'Story- Book (timeline).png' });
    expect(run.rasterize).toHaveBeenCalledTimes(1);
    const svg = run.rasterize.mock.calls[0]?.[0] as string;
    expect(svg).toBe(renderTimelineSvg({ state: project(), includeRootIds: ['manuscript'] }).svg);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(run.download).toHaveBeenCalledTimes(1);
    const [bytes, filename, mime] = run.download.mock.calls[0] as [Uint8Array, string, string];
    expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));
    expect(filename).toBe('Story- Book (timeline).png');
    expect(mime).toBe('image/png');
  });

  it('says so in a whole sentence, and downloads nothing, when the canvas refuses', async () => {
    const run = deps({
      exporter: async () => ({
        renderTimelineSvg,
        rasterizeSvgToPng: async () => {
          throw new Error('this browser gave no 2D canvas context, so the image export cannot be drawn');
        },
      }),
    });
    const outcome = await saveTimelineImage({ state: project(), scopeId: null }, run.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      'The browser could not draw the timeline as an image, so nothing was saved. Try again, or compile the timeline as SVG from the export dialog.',
    );
    expect(outcome.message).not.toContain('2D canvas');
    expect(run.download).not.toHaveBeenCalled();
  });

  it('refuses a scope with no scene instead of saving a blank picture', async () => {
    const run = deps();
    const state = project();
    const outcome = await saveTimelineImage({ state, scopeId: 'n_NOSUCHNODE' }, run.deps);
    expect(outcome.ok).toBe(false);
    expect(run.rasterize).not.toHaveBeenCalled();
    expect(run.download).not.toHaveBeenCalled();
  });

  it('names the file beside the compiled timeline files', () => {
    expect(timelineImageName(project('A/B'))).toBe('A-B (timeline).png');
  });
});
