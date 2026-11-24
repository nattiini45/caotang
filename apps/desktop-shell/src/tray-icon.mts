/**
 * The tray's own glyph, 32×32, a page outline drawn in black on transparency — small enough to travel as text, because a binary
 * may not sit under a guarded root (`resources/icon.png.base64` carries the app icon the same way). macOS is asked to treat it as
 * a template image, which is how a menu bar icon follows the system's light and dark appearance.
 */
export const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR42u2WUQoAAATF3P/SXEGJeLbyqfaxwgzgAF4cHYGpPQT2C2Sj0xWgARqggezB0RWggb8Cf39CgFYCJyaxTxMu5eoAAAAASUVORK5CYII=';
