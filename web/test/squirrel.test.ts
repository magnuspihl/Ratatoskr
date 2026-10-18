import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MS, MIN_MS, planRun, revealKeyframes, runFor, runSpeed, SQUIRREL_SIZE, squirrelKeyframes, STRIDE } from '../src/squirrel';

const PHONE = { w: 390, h: 844 };

describe('which run a view change gets', () => {
  it('runs along the bottom, left to right, when the folder drawer opens', () => {
    expect(runFor('list', 'nav')).toBe('navOpen');
    expect(runFor('reader', 'nav')).toBe('navOpen');
  });
  it('runs along the bottom, right to left, when the folder drawer closes', () => {
    expect(runFor('nav', 'list')).toBe('navClose');
    expect(runFor('nav', 'reader')).toBe('navClose');
  });
  it('runs up the left edge to open a message and down it to return to the folder', () => {
    expect(runFor('list', 'reader')).toBe('open');
    expect(runFor('reader', 'list')).toBe('close');
  });
  it('does not run when the view stays the same (e.g. stepping to the next message)', () => {
    expect(runFor('reader', 'reader')).toBeNull();
    expect(runFor('list', 'list')).toBeNull();
  });
});

describe('planning a run', () => {
  it('stays very brief, even across a tall phone screen', () => {
    for (const kind of ['navOpen', 'navClose', 'open', 'close'] as const) {
      const { duration } = planRun(kind, PHONE.w, PHONE.h);
      expect(duration).toBeGreaterThanOrEqual(MIN_MS);
      expect(duration).toBeLessThanOrEqual(MAX_MS);
    }
    expect(planRun('open', 1000, 4000).duration).toBe(MAX_MS);
    expect(planRun('navOpen', 50, 50).duration).toBe(MIN_MS);
  });

  it('speeds the legs up to match the ground covered, so the squirrel does not slide', () => {
    for (const [kind, w, h] of [['navOpen', 390, 844], ['navClose', 390, 844], ['open', 390, 844], ['close', 768, 1024]] as const) {
      const plan = planRun(kind, w, h);
      const speed = Math.abs(plan.to - plan.from) / plan.duration; // px per ms
      expect(plan.cycle * speed).toBeCloseTo(STRIDE, -1);
    }
    // A longer run squeezed into the same maximum time means a faster leg cycle.
    expect(planRun('open', 390, 1200).cycle).toBeLessThan(planRun('open', 390, 900).cycle);
  });

  it('takes longer at Medium and longer still at Slow, with Fast unchanged as the quickest', () => {
    for (const kind of ['navOpen', 'navClose', 'open', 'close'] as const) {
      const fast = planRun(kind, PHONE.w, PHONE.h, 'fast');
      const medium = planRun(kind, PHONE.w, PHONE.h, 'medium');
      const slow = planRun(kind, PHONE.w, PHONE.h, 'slow');
      expect(fast).toEqual(planRun(kind, PHONE.w, PHONE.h));
      expect(medium.duration).toBeGreaterThan(fast.duration);
      expect(slow.duration).toBeGreaterThan(medium.duration);
    }
    // Fast keeps the original timing: about 0.3 s across a phone, capped at 0.45 s top to bottom.
    expect(planRun('navOpen', PHONE.w, PHONE.h, 'fast').duration).toBe(284);
    expect(planRun('open', PHONE.w, PHONE.h, 'fast').duration).toBe(MAX_MS);
  });

  it('slows the legs down along with the run at slower settings, so the squirrel never slides', () => {
    for (const speed of ['fast', 'medium', 'slow'] as const) {
      for (const kind of ['navOpen', 'open'] as const) {
        const plan = planRun(kind, PHONE.w, PHONE.h, speed);
        expect(plan.cycle * (Math.abs(plan.to - plan.from) / plan.duration)).toBeCloseTo(STRIDE, -1);
      }
    }
    expect(planRun('navOpen', PHONE.w, PHONE.h, 'slow').cycle).toBeGreaterThan(planRun('navOpen', PHONE.w, PHONE.h, 'fast').cycle);
  });

  it('starts just off one edge and finishes fully past the other', () => {
    expect(planRun('navOpen', PHONE.w, PHONE.h)).toMatchObject({ from: -SQUIRREL_SIZE, to: PHONE.w });
    expect(planRun('navClose', PHONE.w, PHONE.h)).toMatchObject({ from: PHONE.w, to: -SQUIRREL_SIZE });
    expect(planRun('open', PHONE.w, PHONE.h)).toMatchObject({ from: PHONE.h, to: -SQUIRREL_SIZE });
    expect(planRun('close', PHONE.w, PHONE.h)).toMatchObject({ from: -SQUIRREL_SIZE, to: PHONE.h });
  });

  it('moves left to right to open the drawer, right to left to close it, bottom to top to open a message and top to bottom to return', () => {
    expect(squirrelKeyframes(planRun('navOpen', 390, 844))).toEqual([{ transform: 'translateX(-64px)' }, { transform: 'translateX(390px)' }]);
    expect(squirrelKeyframes(planRun('navClose', 390, 844))).toEqual([{ transform: 'translateX(390px)' }, { transform: 'translateX(-64px)' }]);
    expect(squirrelKeyframes(planRun('open', 390, 844))).toEqual([{ transform: 'translateY(844px)' }, { transform: 'translateY(-64px)' }]);
    expect(squirrelKeyframes(planRun('close', 390, 844))).toEqual([{ transform: 'translateY(-64px)' }, { transform: 'translateY(844px)' }]);
  });
});

describe('the new view following the squirrel', () => {
  it('is wiped in from the side the squirrel comes from', () => {
    expect(revealKeyframes(planRun('navOpen', 390, 844))[0]!.clipPath).toBe('inset(0 100% 0 0)');
    expect(revealKeyframes(planRun('navClose', 390, 844))[0]!.clipPath).toBe('inset(0 0 0 100%)');
    expect(revealKeyframes(planRun('open', 390, 844))[0]!.clipPath).toBe('inset(100% 0 0 0)');
    expect(revealKeyframes(planRun('close', 390, 844))[0]!.clipPath).toBe('inset(0 0 100% 0)');
    for (const kind of ['navOpen', 'navClose', 'open', 'close'] as const) expect(revealKeyframes(planRun(kind, 390, 844)).at(-1)!.clipPath).toBe('inset(0 0 0 0)');
  });

  it("keeps the edge under the squirrel's middle, starting as it enters the screen and done as it leaves", () => {
    for (const [kind, start, end] of [['navOpen', 0, 390], ['navClose', 390, 0]] as const) {
      const plan = planRun(kind, 390, 844);
      const at = (t: number) => plan.from + (plan.to - plan.from) * t + SQUIRREL_SIZE / 2;
      expect(at(plan.enter)).toBeCloseTo(start);
      expect(at(plan.leave)).toBeCloseTo(end);
      expect(revealKeyframes(plan).map((f) => f.offset)).toEqual([0, plan.enter, plan.leave, 1]);
    }
  });
});

describe('the Screen Transitions setting', () => {
  it('runs at Fast by default on phones', () => {
    expect(runSpeed(undefined, true, false)).toBe('fast');
  });
  it('runs at the chosen speed', () => {
    expect(runSpeed('fast', true, false)).toBe('fast');
    expect(runSpeed('medium', true, false)).toBe('medium');
    expect(runSpeed('slow', true, false)).toBe('slow');
  });
  it('does not run when set to Off, on the desktop layout, or with reduced motion', () => {
    expect(runSpeed('off', true, false)).toBeNull();
    expect(runSpeed('slow', false, false)).toBeNull();
    expect(runSpeed('medium', true, true)).toBeNull();
  });
});

describe('the squirrel artwork', () => {
  const svg = fs.readFileSync(path.resolve(import.meta.dirname, '../src/assets/squirrel-running.svg'), 'utf8');
  it('follows the theme colour and has a single running cycle whose speed can be set', () => {
    expect(svg).toContain('fill="currentColor"');
    expect(svg.match(/dur="[^"]*"/g)).toHaveLength(1);
  });
});
