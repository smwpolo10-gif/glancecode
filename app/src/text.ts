// Pixel-accurate text layout for the G2 firmware font (via @evenrealities/pretext).
// We wrap every line ourselves so the firmware never re-wraps or scrolls a container.
import { getTextWidth, pxTruncate } from "@evenrealities/pretext";

export const SCREEN_W = 576;
export const LINE_H = 27;

/** Characters the firmware font can't draw are dropped silently; map the common ones. */
const GLYPH_FALLBACKS: Record<string, string> = {
  "✓": "√", "✔": "√", "✗": "×", "✕": "×", "❯": "›", "⏺": "●", "⎿": "└", "▸": "▶", "◦": "·", "‣": "•",
  "⚠": "!", "☐": "□", "☑": "■", "✻": "*", "✳": "*", "⋯": "…", "“": '"', "”": '"', "‘": "'", "’": "'",
};

export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9) out += "  ";
    else if (cp < 32 && cp !== 10) continue;
    else if (cp >= 0x1f000) continue; // emoji
    else out += GLYPH_FALLBACKS[ch] ?? ch;
  }
  return out;
}

export function width(text: string): number {
  return getTextWidth(text);
}

export function truncate(text: string, maxPx: number): string {
  return getTextWidth(text) <= maxPx ? text : pxTruncate(text, maxPx);
}

/** Pad with spaces until `text` is at least `px` wide. */
export function padTo(text: string, px: number): string {
  let s = text;
  let guard = 0;
  while (getTextWidth(s) < px && guard++ < 200) s += " ";
  return s;
}

/** Left and right text on one line, right side flush to `lineW`. */
export function spread(left: string, right: string, lineW: number): string {
  const rightW = getTextWidth(right);
  const leftT = truncate(left, Math.max(0, lineW - rightW - 12));
  let s = leftT;
  let guard = 0;
  while (getTextWidth(s + " " + right) <= lineW && guard++ < 300) s += " ";
  return right ? s + right : leftT;
}

/**
 * Greedy word wrap. Lines after the first are prefixed with `indent`.
 * Words wider than the line are split by character.
 */
export function wrap(text: string, maxPx: number, firstPrefix = "", indent = ""): string[] {
  const out: string[] = [];
  const paragraphs = sanitize(text).split("\n");
  let first = true;
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = first ? firstPrefix : indent;
    const base = line;
    let lineHasText = false;
    const push = () => {
      out.push(line.replace(/\s+$/, ""));
      line = indent;
      lineHasText = false;
    };
    if (!words.length) {
      out.push(first ? firstPrefix.trimEnd() : "");
      first = false;
      continue;
    }
    for (const w of words) {
      if (/^\s+$/.test(w)) {
        if (lineHasText) line += " ";
        continue;
      }
      if (getTextWidth(line + w) <= maxPx) {
        line += w;
        lineHasText = true;
        continue;
      }
      if (lineHasText) push();
      let rest = w;
      while (getTextWidth(line + rest) > maxPx) {
        let n = rest.length;
        while (n > 1 && getTextWidth(line + rest.slice(0, n)) > maxPx) n--;
        line += rest.slice(0, n);
        rest = rest.slice(n);
        lineHasText = true;
        push();
      }
      line += rest;
      lineHasText = rest.length > 0;
    }
    if (lineHasText || line !== base) push();
    first = false;
  }
  return out;
}
