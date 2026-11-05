// Every stage on caotang.app, rendered to static markup at build time by tools/build-site.mjs. Nothing here runs in the browser.
import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Hero, HeroCompact } from './hero'
import { Board, BoardCompact } from './board'
import { Local } from './local'
import { Binder } from './binder'
import { Export } from './export'
import { Findings } from './findings'

/** The stylesheets of the stages, in cascade order: the kit parts they use (each in the kit's own layer), then the look, then each stage. */
export const CSS_FILES = [
  'stageshow-kit/stage.css',
  'stageshow-kit/cursor.css',
  'stageshow-kit/window.css',
  'stageshow-kit/parts/Row.css',
  'stageshow-kit/controls/Badge.css',
  'stageshow-kit/motion/Connector.css',
  'stages/look-caotang.css',
  'stages/hero/hero.css',
  'stages/board/board.css',
  'stages/local/local.css',
  'stages/binder/binder.css',
  'stages/export/export.css',
  'stages/findings/findings.css',
]

/**
 * Every stage by the name its marker uses, so `tools/build-site.mjs` can put each one where `site/index.html` has its
 * `<!-- stage:name -->` marker.
 */
export const STAGES: Record<string, () => ReactElement> = {
  hero: Hero,
  'hero-compact': HeroCompact,
  board: Board,
  'board-compact': BoardCompact,
  local: Local,
  binder: Binder,
  export: Export,
  findings: Findings,
}

/**
 * Each stage's markup, by the name its `<!-- stage:name -->` marker in site/index.html uses. renderToString rather than static markup,
 * so each picture is one component rendered once at build time.
 */
export function renderAll(): Record<string, string> {
  return Object.fromEntries(Object.entries(STAGES).map(([name, Component]) => [name, renderToString(<Component />)]))
}
