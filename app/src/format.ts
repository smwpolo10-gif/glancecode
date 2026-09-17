// Turn session items into wrapped display lines.
import type { Item, SessionSummary, State } from "./types.ts";
import { wrap, width } from "./text.ts";

export const GLYPH: Record<State, string> = {
  starting: "○",
  working: "◐",
  idle: "○",
  waiting: "◆",
  ended: "×",
};

export function stateLabel(s: SessionSummary): string {
  if (s.state === "waiting") return s.waiting?.kind === "question" ? "question" : "needs approval";
  if (s.state === "working") return "working";
  if (s.state === "starting") return "starting";
  if (s.state === "ended") return "ended";
  return s.backgroundTasks ? `idle · ${s.backgroundTasks} bg` : "idle";
}

export function shortModel(model: string | null): string {
  if (!model) return "";
  if (/^gpt-/i.test(model)) return model.replace(/^gpt/i, "GPT");
  const m = /(opus|sonnet|haiku|fable)[-_]?(\d+(?:[-.]\d+)?)?/i.exec(model);
  if (!m) return model;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] ? `${name} ${m[2].replace("-", ".")}` : name;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Light markdown cleanup: keep structure readable, drop fence markers. */
export function tidyMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let blank = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) continue;
    line = line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    line = line.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/, ""); // table separator rows
    if (!line.trim()) {
      if (!blank && out.length) out.push("");
      blank = true;
      continue;
    }
    blank = false;
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

const USER_PREFIX = "» ";
const TOOL_PREFIX = "▷ ";

/**
 * Render items to lines. Consecutive tool calls with the same tool collapse,
 * and a blank line separates turns.
 */
export function itemsToLines(items: Item[], maxPx: number): string[] {
  const lines: string[] = [];
  const userIndent = " ".repeat(Math.ceil(width(USER_PREFIX) / width(" ")));
  const toolIndent = " ".repeat(Math.ceil(width(TOOL_PREFIX) / width(" ")));
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "tool") {
      // Collapse a run of tool calls: repeated tools become "Read ×3".
      const run: Item[] = [];
      while (i < items.length && items[i].kind === "tool") run.push(items[i++]);
      const groups: { tool: string; last: string; n: number }[] = [];
      for (const t of run) {
        const g = groups[groups.length - 1];
        if (g && g.tool === t.tool) {
          g.n++;
          g.last = t.text;
        } else groups.push({ tool: t.tool || "Tool", last: t.text, n: 1 });
      }
      const shown = groups.length > 3 ? groups.slice(-3) : groups;
      if (groups.length > 3) lines.push(`${TOOL_PREFIX}${groups.length - 3} more steps`);
      for (const g of shown) {
        const label = g.n > 1 ? `${g.tool} ×${g.n} · ${g.last}` : `${g.tool} ${g.last}`;
        lines.push(...wrap(label, maxPx, TOOL_PREFIX, toolIndent).slice(0, 2));
      }
      continue;
    }
    if (it.kind === "user") {
      if (lines.length) lines.push("");
      lines.push(...wrap(it.text, maxPx, USER_PREFIX, userIndent));
    } else if (it.kind === "assistant") {
      lines.push(...wrap(tidyMarkdown(it.text), maxPx));
    } else if (it.kind === "error") {
      lines.push(...wrap(it.text, maxPx, "! ", "  "));
    } else {
      lines.push(...wrap(it.text, maxPx, "◇ ", "   "));
    }
    i++;
  }
  // Collapse runs of blank lines produced at item boundaries.
  return lines.filter((l, idx) => l !== "" || (idx > 0 && lines[idx - 1] !== ""));
}
