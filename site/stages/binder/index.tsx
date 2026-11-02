import type { ReactNode } from 'react'
import { Stage } from '../../stageshow-kit/stage'
import { Bar, Text } from '../../stageshow-kit/window'
import { Row } from '../../stageshow-kit/parts/Row'
import { Glyph, type GlyphName } from '../icons'

// The Binder tile: Modern's binder tree, cropped off the tile's left and its foot. Part One open, Chapter 3 open with its three
// scenes, one selected on Modern's gray pill, and the chapter's goal met: its ring full, 2,512 of 2,500 words.
//
// Gold: `static-card` (the hard crop, a quiet hierarchy, real words only on what the story is about) and `table-edit` (the total the
// writing feeds, on its own row). The rows are the kit's Row at Modern's 44 px.
//
// Real strings (5): the chapter, its three scenes and its total. The part and the next chapter are filler.

function Lead({ icon, chevron }: { icon: GlyphName; chevron?: 'open' | 'closed' | 'none' }) {
  return (
    <span className="bn-lead">
      <span className="bn-indent" />
      <span className="bn-chevron">{chevron === 'open' ? <Glyph name="chevron-down" size={16} /> : chevron === 'closed' ? <Glyph name="chevron-right" size={16} /> : null}</span>
      <Glyph name={icon} size={16} />
    </span>
  )
}

function Ring() {
  return (
    <svg className="bn-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7.5" />
      <path d="M5.6 9.3l2.2 2.2 4.6-4.8" />
    </svg>
  )
}

function Tree({ children }: { children: ReactNode }) {
  return <div className="bn-tree">{children}</div>
}

export function Binder() {
  return (
    <Stage width={333} height={270} className="cao-fit bn">
      {() => (
        <div className="bn-panel">
          <Tree>
            <Row className="bn-row bn-row--d0" lead={<Lead icon="folder" chevron="open" />} title={<Bar w={64} h={8} r={4} tone={4} />} />
            <Row
              className="bn-row bn-row--d1 bn-row--chapter"
              lead={<Lead icon="folder" chevron="open" />}
              title={<Text>Chapter 3</Text>}
              meta={
                <span className="bn-goal">
                  <Ring />
                  <Text>2,512 / 2,500</Text>
                </span>
              }
            />
            <Row className="bn-row bn-row--d2" lead={<Lead icon="file-text" />} title={<Text>Low tide</Text>} />
            <Row className="bn-row bn-row--d2" selected lead={<Lead icon="file-text" />} title={<Text>The keeper’s log</Text>} />
            <Row className="bn-row bn-row--d2" lead={<Lead icon="file-text" />} title={<Text>Fog on the causeway</Text>} />
            <Row className="bn-row bn-row--d1" lead={<Lead icon="folder" chevron="closed" />} title={<Bar w={72} h={8} r={4} tone={3} />} />
          </Tree>
        </div>
      )}
    </Stage>
  )
}
