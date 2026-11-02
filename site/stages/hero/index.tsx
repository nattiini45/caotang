import { Stage } from '../../stageshow-kit/stage'
import { Bar } from '../../stageshow-kit/window'
import { Glyph } from '../icons'

// The hero still: a writer selected a paragraph in Modern, asked the agent to tighten it, and the draft now waits under the text with
// Apply. The poster beat of the hero demo (landing.md §C): the page's promise is that the agent asks first, and the settled draft
// waiting on Apply says it in one frame, with nothing mid-change.
//
// Gold: `raycast` for the layout (a stage with gutters on the product's own ground; here the harbour wallpaper is the page's hero band,
// never a plate) and `hero-demo` for the composition (one hero surface, a satellite straddling its edge, the cursor resting on the
// payoff). The page is the hero: inset from both sides, it runs off the stage's foot into the page below. The agent window is the
// satellite over the page's right margin, whole, never over the words.
//
// The ghost capsule is drawn as the Modern spec intends it (modern-interface.md §7.3, e2e/modern-homes.ts "ghost-bar": a glass capsule
// pinned inside the page above the bottom ornament, one primary, Apply). Today's app still draws Classic's bar there; re-check this
// still after #361 lands so the picture never shows a better UI than the product.
//
// Each label sits in its own span inside its pill or button, so the words are measured from the pill they sit in.
//
// Real strings (7): the title capsule (project, save state), the scene title, the selected paragraph, the draft, the request, the
// agent's status, the capsule's count and buttons. The rest is cropped or filler.

export const SELECTED =
  'The ferry came in on the evening tide, low in the water and slow to answer the rope, and for a long while nobody on the quay moved at all. Mara waited by the bollards with her collar turned up and the folded letter in her pocket, telling herself that she had not come all this way only to stand in the rain and watch strangers step ashore.'

export const DRAFT =
  'The ferry came in on the evening tide, low in the water and slow to the rope. Nobody on the quay moved. Mara waited by the bollards, collar up, the letter folded in her pocket. She had not come this far to stand in the rain and watch strangers step ashore.'

export const DRAFT_WORDS = DRAFT.split(/\s+/).length

function Ornament({ compact }: { compact?: boolean }) {
  return (
    <div className="hero-ornament cao-glass">
      <span className="hero-ornament__title">
        <span>The Lighthouse Keeper</span>
      </span>
      {!compact && (
        <span className="hero-ornament__state">
          <span>All changes saved in this browser</span>
        </span>
      )}
      <span className="hero-ornament__more">
        <Glyph name="more" size={20} />
      </span>
    </div>
  )
}

function Capsule({ compact }: { compact?: boolean }) {
  return (
    <div className="hero-capsule cao-glass">
      {!compact && (
        <span className="hero-capsule__count">
          <span>Draft · {DRAFT_WORDS} words</span>
        </span>
      )}
      <span className="cao-btn cao-btn--primary" data-target="apply">
        <span>Apply</span>
      </span>
      <span className="cao-btn cao-btn--quiet">
        <span>Retry</span>
      </span>
      <span className="cao-btn cao-btn--quiet">
        <span>Discard</span>
      </span>
    </div>
  )
}

function Page({ compact }: { compact?: boolean }) {
  return (
    <div className="hero-page">
      <div className="hero-page__text">
        <div className="hero-title">The Landing</div>
        {/* The passage: the paragraph the request was made on, and the draft under it. */}
        <div className="hero-passage">
          <p className="hero-para">
            <span className="hero-selection">{SELECTED}</span>
          </p>
          <div className="hero-ghost">
            <p className="hero-para">{DRAFT}</p>
          </div>
        </div>
      </div>
      {!compact && <Capsule />}
    </div>
  )
}

function Agent() {
  return (
    <div className="hero-agent cao-glass">
      <div className="hero-agent__head">
        <span className="hero-agent__name">Agent</span>
        <span className="hero-agent__close">
          <Glyph name="close" size={18} />
        </span>
      </div>
      <div className="hero-agent__status">Waiting for you · Draft “The Landing”</div>
      <div className="hero-agent__turn">
        <span className="hero-agent__intent">“Tighten this paragraph.”</span>
        <span className="hero-agent__mode">Ask</span>
      </div>
      <div className="hero-agent__composer">
        <Bar w={132} h={7} r={3.5} tone={3} />
        <span className="hero-agent__send" />
      </div>
    </div>
  )
}

/** The hero at 1:1 in the 1032 px column, the page from the band into the page below. */
export function Hero() {
  return (
    <Stage width={1032} height={560} fidelity="realistic" cursor={{ at: 'apply', kind: 'hand', still: true }} className="cao-fit hero-stage">
      {() => (
        <div className="hero-scene">
          <Page />
          <Ornament />
          <Agent />
        </div>
      )}
    </Stage>
  )
}

/**
 * The phone column's hero, a redesign rather than the wide one shrunk (landing.md §C, Compact): the page alone, cropped to the paragraph
 * and its draft, the compact title capsule above, and the capsule whole. No satellite: on a phone the agent is a full-screen sheet.
 */
export function HeroCompact() {
  return (
    <Stage width={358} height={652} fidelity="realistic" cursor={{ at: 'apply', kind: 'hand', still: true }} className="cao-fit hero-stage hero-stage--compact">
      {() => (
        <div className="hero-scene">
          <Page compact />
          <Ornament compact />
          <Capsule compact />
        </div>
      )}
    </Stage>
  )
}
