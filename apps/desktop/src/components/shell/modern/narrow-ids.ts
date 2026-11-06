/**
 * The narrow layout's ids (#312, #480), apart from narrow-panels.tsx so the bottom ornament's **Binder** tab can name the drawer
 * without pulling the narrow layout's lazy chunk (and its stylesheet) into the shell. Classic's narrow ids, so the workspace's own
 * focus rule for the rail drawer finds them.
 */
export const DRAWER_ID = 'narrow-rail';
export const BINDER_BUTTON_ID = 'narrow-toggle-rail';
