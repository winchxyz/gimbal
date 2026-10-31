// The Welcome gimbal is drawn by two plain scripts from the design (gimbal-fx.js: WebGL2 shader; gimbal.js: the 2D
// fallback). They register themselves on `window`; this declares what the page uses of them.
export interface HeroOptions {
  look?: 'phosphor' | 'lit' | 'edges';
  /** Centre of the gimbal as a fraction of the canvas. */
  cx: number;
  cy: number;
  /** Outer radius as a fraction of the canvas height. */
  size: number;
  /** Elements the field softens behind, so the copy always wins. */
  quiet?: HTMLElement[];
  /** One still frame instead of the swing. */
  still?: boolean;
  /** Seconds into the swing. */
  t?: number;
  /** Aborting stops the loop. */
  signal?: AbortSignal;
}

declare global {
  interface Window {
    /** Resolves false when WebGL2 is missing. */
    GimbalFX?: { mount(canvas: HTMLCanvasElement, options: HeroOptions): Promise<boolean> };
    GimbalAscii?: { mount(canvas: HTMLCanvasElement, options: HeroOptions): Promise<void> };
  }
}
