// Today's Plausible numbers, published as a calendar feed so the Even G2
// dashboard's Calendar widget can show them without opening an app.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.mjs";

export const PLAUSIBLE_KEY_FILE = join(CONFIG_DIR, "plausible.key");

/**
 * Products to count, set in the config as `statsProducts`. Each metric is unique
 * visitors for today on a Plausible site, narrowed by an optional goal and extra
 * Plausible filters. The Stats API matches goals by their display name, so list
 * the display name first and the raw event name after it as a fallback:
 *
 *   { "label": "Shop", "site": "example.com",
 *     "visitors": { "goal": ["Homepage visited"] },
 *     "appStore": { "goal": ["App Store Badge Clicked", "app_store_clicked"] },
 *     "playStore": { "goal": ["Google Play Badge Clicked", "play_store_clicked"] } }
 */
export const DEFAULT_PRODUCTS = [];

function localDate(d = new Date()) {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the Mac's timezone
}

export class Stats {
  constructor({ products = DEFAULT_PRODUCTS, server = "https://plausible.io", refreshMs = 10 * 60_000, log = () => {} } = {}) {
    this.products = products;
    this.server = server.replace(/\/$/, "");
    this.refreshMs = refreshMs;
    this.log = log;
    this.state = null;
    this.timer = null;
  }

  get key() {
    try {
      return existsSync(PLAUSIBLE_KEY_FILE) ? readFileSync(PLAUSIBLE_KEY_FILE, "utf8").trim() : "";
    } catch {
      return "";
    }
  }

  start() {
    if (!this.key) return this;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  async query(body) {
    const res = await fetch(`${this.server}/api/v2/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Plausible ${res.status}`);
    return data.results?.[0]?.metrics?.[0] ?? 0;
  }

  async count(product, date, spec) {
    const goals = spec.goal ? [].concat(spec.goal) : [null];
    let lastError;
    for (const goal of goals) {
      const filters = [...(goal ? [["is", "event:goal", [goal]]] : []), ...(spec.filters || [])];
      try {
        return await this.query({ site_id: product.site, metrics: ["visitors"], date_range: [date, date], filters });
      } catch (err) {
        lastError = err;
        if (!/not configured/i.test(err.message)) throw err; // only fall through on a goal-name miss
      }
    }
    throw new Error(`no goal named ${goals.map((g) => `"${g}"`).join(" or ")} on ${product.site}`);
  }

  async refresh() {
    if (!this.key) {
      this.state = { error: "No Plausible key. Run: glancecode stats key", updatedAt: Date.now() };
      return this.state;
    }
    const date = localDate();
    const products = await Promise.all(
      this.products.map(async (product) => {
        const row = { label: product.label, site: product.site, visitors: null, appStore: null, playStore: null, errors: [] };
        for (const field of ["visitors", "appStore", "playStore"]) {
          if (!product[field]) continue;
          try {
            row[field] = await this.count(product, date, product[field]);
          } catch (err) {
            row.errors.push(`${field}: ${err.message}`);
          }
        }
        return row;
      }),
    );
    this.state = { date, updatedAt: Date.now(), products };
    const errs = products.flatMap((p) => p.errors.map((e) => `${p.label} ${e}`));
    if (errs.length) this.log(`stats: ${errs.join("; ")}`);
    return this.state;
  }

  /** One short line per product, e.g. "Shop 120 visits · 4 App Store · 2 Play". */
  lines() {
    const s = this.state;
    if (!s) return ["Site stats loading"];
    if (s.error) return [s.error];
    const n = (v) => (v === null ? "?" : String(v));
    return s.products.map((p) => `${p.label} ${n(p.visitors)} visits · ${n(p.appStore)} App Store · ${n(p.playStore)} Play`);
  }

  summary() {
    return this.lines().join("\n");
  }

  updatedLabel() {
    const at = this.state?.updatedAt;
    return at ? `Updated ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";
  }

  /**
   * One all-day event per product for today, which the Calendar widget labels
   * "All Day". UIDs are stable per product and day, so updates replace them.
   */
  ics(now = new Date()) {
    const day = (d) => localDate(d).replace(/-/g, "");
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const updated = new Date(this.state?.updatedAt || now);
    const titles = this.lines();
    const keys = this.state?.products ? this.state.products.map((p) => p.label.toLowerCase()) : ["status"];
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//glancecode//site stats//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Site stats",
      "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
      "X-PUBLISHED-TTL:PT15M",
    ];
    titles.forEach((title, i) => {
      lines.push(
        "BEGIN:VEVENT",
        `UID:site-stats-${keys[i]}-${localDate(now)}@glancecode`,
        `DTSTAMP:${stamp(now)}`,
        `LAST-MODIFIED:${stamp(updated)}`,
        `SEQUENCE:${Math.floor(updated.getTime() / 60_000)}`,
        `DTSTART;VALUE=DATE:${day(now)}`,
        `DTEND;VALUE=DATE:${day(tomorrow)}`,
        `SUMMARY:${esc(title)}`,
        `DESCRIPTION:${esc(this.updatedLabel())}`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      );
    });
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }
}

/** RFC 5545 lines are at most 75 octets; continue with CRLF + space. */
export function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
