import { Stage } from '../../stageshow-kit/stage'
import { Connector } from '../../stageshow-kit/motion/Connector'
import { Glyph } from '../icons'

// The Codex & Findings tile: one sentence of prose with a codex name marked as a mention, and one finding pinned to the passage it
// is about by a single neutral leader. The finding's words are the app's own (packages/coherence, the "knows before learning" check
// and its type label); its one action, Show on timeline, is the Findings tab's.
//
// Gold: `form-error` (the error on the thing that caused it) and `panel-annotation` (one leader through empty ground, from the cause
// to the card). The leader's ends are placed from the still's fixed layout: the page runs no script to measure them.
//
// Real strings (5): the sentence, the mention, the type, the message, the action.

export function Findings() {
  return (
    <Stage width={333} height={280} className="cao-fit fd">
      {() => (
        <>
          <div className="fd-page">
            <p className="fd-prose">
              The tide turned at six. <span className="fd-mention">Mara</span> folded the deed into her coat.
            </p>
            <p className="fd-prose">
              <span className="fd-passage">“The light is mine now,”</span> she said.
            </p>
          </div>
          <Connector show from={{ x: 120, y: 84 }} to={{ x: 120, y: 135 }} route="straight" dots="both" className="fd-leader" />
          <div className="fd-card">
            <div className="fd-card__type">
              <Glyph name="triangle-alert" size={16} />
              <span>Knows before learning</span>
            </div>
            <p className="fd-card__message">“Mara” knows that “she is the keeper’s heir” in “The quay”, but learns it only in “The will”</p>
            <span className="fd-card__action">Show on timeline</span>
          </div>
        </>
      )}
    </Stage>
  )
}
