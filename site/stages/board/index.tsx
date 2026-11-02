import { Stage } from '../../stageshow-kit/stage'
import { Bar, Text } from '../../stageshow-kit/window'
import { Badge } from '../../stageshow-kit/controls/Badge'
import { Glyph } from '../icons'

// The Board tile: a populated board of index cards, cropped off the right and the foot of the page, and one card lifted by its grip
// over the room the others made for it. The moment of placing it, which is what the Board is for.
//
// Gold: `reorder` (a row lifted by its grip, the others making room, the lift shadow and the grab cursor) on the layout of
// `static-card` ("Pinned, bottom bleed": the product's own surface pinned to the tile's top-left gutter, off the right and the foot).
// The cards are Modern's medium cards (grip, title, status, synopsis); only the cards the crop keeps whole have words.
//
// Real strings (5): three scene titles and two statuses (a title is one line on a medium card, so they are short). Synopses and the cut cards are filler.

type CardProps = { title?: string; status?: string; tone?: 'neutral' | 'accent' | 'success' | 'warning'; titleW?: number; lines?: number[]; className?: string; target?: string }

function Card({ title, status, tone = 'neutral', titleW = 96, lines = [128, 100], className, target }: CardProps) {
  return (
    <div className={`bd-card${className ? ` ${className}` : ''}`}>
      <div className="bd-card__head">
        <span className="bd-card__grip" data-target={target}>
          <Glyph name="grip" size={16} />
        </span>
        {title ? <Text className="bd-card__title">{title}</Text> : <Bar w={titleW} h={8} r={4} tone={4} />}
      </div>
      {status ? (
        <Badge dot tone={tone} className="bd-card__status">
          {status}
        </Badge>
      ) : (
        <Bar w={64} h={18} r={9} tone={2} />
      )}
      <div className="bd-card__synopsis">
        {lines.map((w, i) => (
          <Bar key={i} w={w} h={6} r={3} tone={2} />
        ))}
      </div>
    </div>
  )
}

export function Board() {
  return (
    <Stage width={654} height={272} cursor={{ at: 'grip', kind: 'grab', still: true }} className="cao-fit bd bd--wide">
      {() => (
        <div className="bd-page">
          <div className="bd-grid">
            <Card title="The ferry" status="First draft" />
            <div className="bd-slot" />
            <Card title="The letter" status="Revised" tone="success" lines={[124, 92]} />
            <Card className="bd-card--peek" titleW={70} />
            <Card titleW={84} lines={[122, 90]} />
            <Card titleW={100} lines={[110, 128]} />
            <Card titleW={76} lines={[128, 84]} />
            <Card className="bd-card--peek" titleW={64} />
          </div>
          <Card title="Night crossing" status="Revised" tone="success" lines={[126, 98]} className="bd-card--lifted" target="grip" />
        </div>
      )}
    </Stage>
  )
}

/** The phone column's Board: two cards wide, the lifted card over its slot at the start of the first row, the page off the right. Only the
 *  two whole cards of the first row carry words, the two shortest titles, so each sits on one line in a phone-width card. */
export function BoardCompact() {
  return (
    <Stage width={338} height={262} cursor={{ at: 'grip', kind: 'grab', still: true }} className="cao-fit bd bd--compact">
      {() => (
        <div className="bd-page">
          <div className="bd-grid">
            <div className="bd-slot" />
            <Card title="The ferry" status="First draft" lines={[100, 78]} />
            <Card titleW={80} lines={[96, 70]} />
            <Card titleW={70} lines={[100, 64]} />
          </div>
          <Card title="The letter" status="Revised" tone="success" lines={[100, 74]} className="bd-card--lifted" target="grip" />
        </div>
      )}
    </Stage>
  )
}
