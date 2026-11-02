import { Stage } from '../../stageshow-kit/stage'
import { Glyph } from '../icons'

// The local-first tile's picture: one small glass field, hung from the tile's top-right corner and off both those edges, over the
// harbour wallpaper the tile is cut from. The statement ("No account. No server.") is page text in the opposite corner.
//
// Gold: `opposite-corners` (copy bottom-left, the product hung from the top-right corner, a clear diagonal of ground between them).
// The field is Settings › Providers' key field as Modern draws it, its value sealed.
//
// Real strings (3): the label, the sealed value's mask, "Sealed in this browser".

export function Local() {
  return (
    <Stage width={333} height={200} className="cao-fit lc">
      {() => (
        <div className="lc-panel cao-glass">
          <div className="lc-label">API key</div>
          <div className="lc-field">
            <Glyph name="key-round" size={16} />
            <span className="lc-mask">••••••••••••</span>
          </div>
          <div className="lc-note">
            <Glyph name="lock" size={14} />
            <span>Sealed in this browser</span>
          </div>
        </div>
      )}
    </Stage>
  )
}
