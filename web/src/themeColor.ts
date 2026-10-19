import type { ResolvedTheme } from './hooks';

// The browser chrome colour per theme: the page background (--bg in styles.css), so Android's status and navigation
// bars blend into the app.
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#f6f6f4', dark: '#141517' };

interface ThemeColorDoc {
  querySelectorAll(selector: string): Iterable<{ setAttribute(name: string, value: string): void }>;
}

// index.html picks a theme-color by prefers-color-scheme; this pins every variant to the app's resolved theme, so an
// explicit light/dark preference that differs from the phone's setting also recolours the bars.
export function applyThemeColor(doc: ThemeColorDoc, theme: ResolvedTheme): void {
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', THEME_COLORS[theme]);
}
