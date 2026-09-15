// Optional phone push via ntfy. The Even app mirrors iPhone notifications to the
// glasses, which is the only way to reach you while another glasses app is open.
export class Notifier {
  constructor({ server, topic, log = () => {} }) {
    this.server = (server || "https://ntfy.sh").replace(/\/$/, "");
    this.topic = topic;
    this.log = log;
    this.glassesForegroundUntil = 0;
    this.lastSent = new Map();
  }

  get enabled() {
    return !!this.topic;
  }

  /** The glasses app pings while it is open; no pushes while you are looking at it. */
  markForeground(ms = 45_000) {
    this.glassesForegroundUntil = Date.now() + ms;
  }

  async send(key, title, message) {
    if (!this.enabled || Date.now() < this.glassesForegroundUntil) return false;
    const last = this.lastSent.get(key) || 0;
    if (Date.now() - last < 20_000) return false; // one push per session event burst
    this.lastSent.set(key, Date.now());
    try {
      const res = await fetch(`${this.server}/${encodeURIComponent(this.topic)}`, {
        method: "POST",
        headers: { Title: title, Tags: "robot" },
        body: message.slice(0, 180),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      this.log(`ntfy failed: ${err.message}`);
      return false;
    }
  }
}
