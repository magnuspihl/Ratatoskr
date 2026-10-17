import { useMemo } from 'react';
import { buildSrcdoc, type RenderMode, type RenderPalette } from '../../../shared/srcdoc';

function palette(): RenderPalette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { background: v('--message-bg'), text: v('--text'), muted: v('--muted'), link: v('--link'), border: v('--border-strong') };
}

/**
 * Renders sanitized message HTML in a sandboxed iframe: no scripts, opaque origin (no access to
 * the app, its cookies or storage), no forms, no top navigation. Links open in a new tab
 * (allow-popups) without an opener. A CSP inside the document blocks every network request except
 * the app's signed image proxy.
 */
export function MessageFrame({ html, css, mode, themeKey }: { html: string; css: string; mode: RenderMode; themeKey: string }) {
  const srcDoc = useMemo(
    () => buildSrcdoc({ html, css, mode, origin: window.location.origin, palette: palette() }),
    // themeKey forces a rebuild when the app theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, css, mode, themeKey],
  );
  return (
    <iframe
      className="msg-frame"
      title="Message content"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}
