/**
 * dsh-wallpaper-engine — client (browser) half.
 *
 * A compiled browser module in the `window.__ModuleLoader__.load({ id,
 * factory })` form. The factory returns the plugin exports declared below. It
 * is a normal browser module (full access to fetch/document/window; `react` via
 * `require("react")`), distinct from the dynamic cordis_define closure whose
 * traps and withheld globals do not apply here.
 */

import type { Context } from '@deepseek-ai/cordis';

/** Declarative service dependency of the browser half: the client `slots` service. */
export declare const inject: string[];

/**
 * Mounts the wallpaper layers, the settings section and the floating rope dock
 * on the client context. Returns nothing; teardown rides the fiber's effects.
 * The client runtime merges the `slots` service into this context.
 */
export declare function apply(ctx: Context): void;

/** The factory's return shape: the browser plugin exports consumed by the Cordis Loader. */
export interface WallpaperEngineClientPlugin {
  apply: typeof apply;
  inject: typeof inject;
}
