import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyThemeColor, THEME_COLORS } from '../src/themeColor';

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8');

function fakeDoc(count: number) {
  const metas = Array.from({ length: count }, () => ({ content: '', setAttribute(_: string, v: string) { this.content = v; } }));
  return { metas, querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? metas : []) };
}

describe('Android system bar colours', () => {
  it('the installed app paints its navigation bar and window dark, never a pale colour', () => {
    // Chrome colours an installed app's navigation bar from the manifest's one theme_color and fills the window
    // behind it with background_color; neither has a dark-mode variant.
    const manifest = JSON.parse(read('../public/manifest.webmanifest')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ theme_color: THEME_COLORS.dark, background_color: THEME_COLORS.dark });
  });

  it('the bar colours match the page background of each theme', () => {
    const css = read('../src/styles.css');
    const bg = (block: string) => css.slice(css.indexOf(block)).match(/--bg: (#[0-9a-f]{6});/)![1];
    expect(THEME_COLORS.light).toBe(bg(':root {'));
    expect(THEME_COLORS.dark).toBe(bg("[data-theme='dark'] {"));
  });

  it('index.html starts with a dark bar colour for phones in dark mode and a light one otherwise', () => {
    const html = read('../index.html');
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)" />`);
  });

  it('choosing dark in the app turns every bar colour dark, even when the phone is in light mode', () => {
    const doc = fakeDoc(2);
    applyThemeColor(doc, 'dark');
    expect(doc.metas.map((m) => m.content)).toEqual(['#141517', '#141517']);
  });

  it('choosing light in the app turns every bar colour light again', () => {
    const doc = fakeDoc(2);
    applyThemeColor(doc, 'dark');
    applyThemeColor(doc, 'light');
    expect(doc.metas.map((m) => m.content)).toEqual(['#f6f6f4', '#f6f6f4']);
  });
});
