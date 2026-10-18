/**
 * Phone screen transitions where the logo squirrel runs across the screen and "drags" the new
 * view in behind it: along the bottom, left to right to open the folder drawer and right to left to
 * close it; up the left edge to open a message and back down it to return to the folder.
 */

/** The phone layout's panes (see `data-view` on `.app`). */
export type PaneView = 'nav' | 'list' | 'reader';

export type RunKind = 'navOpen' | 'navClose' | 'open' | 'close';

/** Which run (if any) takes the screen from one view to another. */
export function runFor(from: PaneView, to: PaneView): RunKind | null {
  if (from === to) return null;
  if (to === 'nav') return 'navOpen';
  if (from === 'nav') return 'navClose';
  return to === 'reader' ? 'open' : 'close';
}

/** Rendered size of the squirrel (its square viewBox), in CSS pixels. */
export const SQUIRREL_SIZE = 64;
/** Ground covered per eight-frame cycle: a sprinting squirrel bounds several body lengths a stride. */
export const STRIDE = SQUIRREL_SIZE * 3.2;
/** Preferred running speed (px/s); the run is then clamped to stay brief on tall screens. */
export const SPEED = 1600;
export const MIN_MS = 240;
export const MAX_MS = 450;

export interface RunPlan {
  kind: RunKind;
  /** Length of the whole run, ms. */
  duration: number;
  /** Length of one running cycle, ms, so the legs keep up with the ground actually covered. */
  cycle: number;
  /** Squirrel position along its path (translateX along the bottom, translateY up or down the left edge), px. */
  from: number;
  to: number;
  /**
   * Fractions of the run at which the squirrel's middle crosses onto and off the screen: the new
   * view's edge follows it between the two.
   */
  enter: number;
  leave: number;
}

/** Plans a run across a `width` x `height` screen. */
export function planRun(kind: RunKind, width: number, height: number): RunPlan {
  const span = isHorizontal(kind) ? width : height;
  const s = SQUIRREL_SIZE;
  // From just off one edge until fully past the other.
  const distance = span + s;
  const duration = Math.round(Math.min(MAX_MS, Math.max(MIN_MS, (distance / SPEED) * 1000)));
  const cycle = Math.round(STRIDE / (distance / duration));
  const [from, to] = kind === 'open' || kind === 'navClose' ? [span, -s] : [-s, span];
  return { kind, duration, cycle, from, to, enter: s / 2 / distance, leave: (span + s / 2) / distance };
}

/** Runs along the bottom edge (the drawer) rather than up or down the left one. */
export function isHorizontal(kind: RunKind): boolean {
  return kind === 'navOpen' || kind === 'navClose';
}

const HIDDEN: Record<RunKind, string> = {
  navOpen: 'inset(0 100% 0 0)', // revealed from the left
  navClose: 'inset(0 0 0 100%)', // revealed from the right
  open: 'inset(100% 0 0 0)', // revealed from the bottom
  close: 'inset(0 0 100% 0)', // revealed from the top
};
const SHOWN = 'inset(0 0 0 0)';

/** Clip-path keyframes for the incoming view, its edge tracking the squirrel. */
export function revealKeyframes(plan: RunPlan): Keyframe[] {
  const hidden = HIDDEN[plan.kind];
  return [
    { offset: 0, clipPath: hidden },
    { offset: plan.enter, clipPath: hidden },
    { offset: plan.leave, clipPath: SHOWN },
    { offset: 1, clipPath: SHOWN },
  ];
}

/** Transform keyframes moving the squirrel along its path. */
export function squirrelKeyframes(plan: RunPlan): Keyframe[] {
  const axis = isHorizontal(plan.kind) ? 'X' : 'Y';
  return [{ transform: `translate${axis}(${plan.from}px)` }, { transform: `translate${axis}(${plan.to}px)` }];
}

/** Whether to run at all: the preference is on, the phone layout is showing, and motion is welcome. */
export function runsEnabled(pref: boolean | undefined, phoneLayout: boolean, reducedMotion: boolean): boolean {
  return pref !== false && phoneLayout && !reducedMotion;
}
