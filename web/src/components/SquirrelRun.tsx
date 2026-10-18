import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import squirrelSvg from '../assets/squirrel-running.svg?raw';
import { revealKeyframes, squirrelKeyframes, type PaneView, type RunPlan } from '../squirrel';

const PANE: Record<PaneView, string> = { nav: '.sidebar', list: '.list', reader: '.reader' };

export interface Run {
  id: number;
  plan: RunPlan;
  /** The view being revealed. */
  to: PaneView;
}

/** One squirrel run: moves the squirrel and wipes the incoming pane in behind it, then calls onDone. */
export function SquirrelRun({ run, appRef, onDone }: { run: Run; appRef: RefObject<HTMLElement | null>; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const { plan } = run;
  // The SVG's own running cycle, sped up to match the ground covered.
  const html = useMemo(() => squirrelSvg.replace(/dur="[^"]*"/, `dur="${plan.cycle}ms"`), [plan.cycle]);

  useLayoutEffect(() => {
    const pane = appRef.current?.querySelector<HTMLElement>(PANE[run.to]);
    const timing: KeyframeAnimationOptions = { duration: plan.duration, easing: 'linear', fill: 'both' };
    const squirrel = ref.current?.animate(squirrelKeyframes(plan), timing);
    const reveal = pane?.animate(revealKeyframes(plan), timing);
    const finished = squirrel ?? reveal;
    if (finished) finished.onfinish = () => done.current();
    else done.current();
    return () => {
      squirrel?.cancel();
      reveal?.cancel();
    };
  }, [run, plan, appRef]);

  return (
    <div ref={ref} className={`squirrel-run ${plan.kind}`} aria-hidden="true">
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
