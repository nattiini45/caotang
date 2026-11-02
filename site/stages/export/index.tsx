import { Stage } from '../../stageshow-kit/stage'

// The Export tile: a loose stack of three pages, the newest on top. The top page is a real screenplay PDF page written by Caotang
// (site/assets/README.md), so its line mixing English, Chinese, Arabic and an emoji is what the export prints, not a drawing; the two
// pages under it are blank stock.
//
// Gold: `tilted-stack` (small alternating angles about each page's own centre, the top page the straightest and the only one with
// words). The page is shown large enough to read (0.9 px per point), so the stack runs off the tile's sides and foot as paper out of a
// printer does, and is told by its top edges; the angles are smaller than the gold's (-3.5, 2.5 and -1 degrees) because a page this
// wide turns its edge further than a receipt does. The words on the top page stay inside the crop.
//
// Real strings: the page itself.

export function Export() {
  return (
    <Stage width={333} height={278} className="cao-fit ex">
      {() => (
        <div className="ex-pile">
          <div className="ex-sheet ex-sheet--back" />
          <div className="ex-sheet ex-sheet--mid" />
          <div className="ex-sheet ex-sheet--top">
            <img className="ex-page" src="/assets/export-page.webp" width="324" height="302" alt="" />
          </div>
        </div>
      )}
    </Stage>
  )
}
