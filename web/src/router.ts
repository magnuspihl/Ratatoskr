import { useCallback, useEffect, useRef, useState } from 'react';
import { buildUrl, parseLocation, readHistoryState, type HistoryState, type Overlay, type Route } from './routing';

export interface Location {
  route: Route;
  state: HistoryState | null;
}

function current(): Location {
  return { route: parseLocation(window.location.pathname, window.location.search), state: readHistoryState(window.history.state) };
}

export interface NavigateOptions {
  /** Replace the current entry instead of pushing a new one. */
  replace?: boolean;
  /** Carry the current overlay (e.g. a non-modal composer) over to the new entry. */
  keepOverlay?: boolean;
}

/**
 * Minimal History API router. The URL holds the view (see routing.ts); history.state marks entries
 * the app pushed itself and which overlay (compose, dialogs, phone drawer) is open on them.
 */
export function useRouter(onPop?: (prev: Location, next: Location) => void) {
  const [loc, setLoc] = useState<Location>(() => {
    const l = current();
    // An overlay can't be restored after a reload (its contents are gone): drop it.
    if (l.state?.overlay) {
      window.history.replaceState({ app: true } satisfies HistoryState, '', window.location.href);
      return { ...l, state: { app: true } };
    }
    return l;
  });
  const locRef = useRef(loc);
  locRef.current = loc;
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;

  useEffect(() => {
    const handler = () => {
      const next = current();
      const prev = locRef.current;
      // Update the ref before notifying, so overlay helpers called from onPop see the new entry.
      locRef.current = next;
      setLoc(next);
      onPopRef.current?.(prev, next);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = useCallback((route: Route, opts: NavigateOptions = {}) => {
    const cur = locRef.current;
    const state: HistoryState = { app: true };
    if (opts.keepOverlay && cur.state?.overlay) state.overlay = cur.state.overlay;
    const url = buildUrl(route);
    if (opts.replace) {
      // Keep the "pushed by the app" marker of the entry being replaced: replacing the landing
      // entry must not make Back think there is an in-app entry behind it.
      const replaced: HistoryState | null = cur.state ? state : opts.keepOverlay && state.overlay ? state : null;
      window.history.replaceState(replaced, '', url);
      setLoc({ route, state: replaced });
    } else {
      window.history.pushState(state, '', url);
      setLoc({ route, state });
    }
  }, []);

  const openOverlay = useCallback((overlay: Overlay) => {
    const cur = locRef.current;
    if (cur.state?.overlay === overlay) return;
    const state: HistoryState = { app: true, overlay };
    // Swap one overlay for another in place, so Back never walks through closed dialogs.
    if (cur.state?.overlay) window.history.replaceState(state, '', window.location.href);
    else window.history.pushState(state, '', window.location.href);
    setLoc({ route: cur.route, state });
  }, []);

  /**
   * Close an overlay from the UI. If the top entry is the overlay's own entry, go back so no dead
   * entry remains; otherwise just clear the flag on the current entry.
   */
  const closeOverlay = useCallback((overlay: Overlay) => {
    const cur = locRef.current;
    if (cur.state?.overlay !== overlay) return;
    window.history.back();
  }, []);

  /** Clear the overlay flag without moving in history (used after navigating while composing). */
  const clearOverlay = useCallback(() => {
    const cur = locRef.current;
    if (!cur.state?.overlay) return;
    const state: HistoryState = { app: true };
    window.history.replaceState(state, '', window.location.href);
    setLoc({ route: cur.route, state });
  }, []);

  /** In-app Back (e.g. the reader's back arrow): history.back() if we pushed the entry. */
  const back = useCallback(
    (fallback: Route) => {
      if (locRef.current.state?.app) window.history.back();
      else navigate(fallback, { replace: true });
    },
    [navigate],
  );

  return { loc, navigate, openOverlay, closeOverlay, clearOverlay, back };
}
