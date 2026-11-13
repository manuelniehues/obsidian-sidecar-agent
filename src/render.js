// Terminal renderer choice (no imports, so tests can load it directly).
// Chromium 150 (Obsidian 1.15.1, Electron 43) breaks xterm's WebGL glyph atlas: tiny glyphs, huge gaps.
// The DOM renderer draws correctly, so fall back to it there.
export const WEBGL_BROKEN_FROM_CHROME = 150;
export function webglBroken(chromeVersion = process.versions?.chrome) {
  const major = parseInt(String(chromeVersion || ""), 10);
  return Number.isFinite(major) && major >= WEBGL_BROKEN_FROM_CHROME;
}
