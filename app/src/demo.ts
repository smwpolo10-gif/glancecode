// A hub that lives entirely in the app, with sample sessions. Used when the app
// is not paired yet, so anyone (including Even Hub reviewers) can try every
// screen without a machine running the hub.
import { Hub } from "./hub.ts";
import { every, later, type Cancel } from "./timers.ts";
import type { Item, RecentProject, RecentSession, SessionSummary } from "./types.ts";

const now = () => Date.now();
let keySeq = 0;
const key = () => `demo-${++keySeq}`;
const iso = (msAgo = 0) => new Date(now() - msAgo).toISOString();

function session(partial: Partial<SessionSummary> & Pick<SessionSummary, "id" | "project">): SessionSummary {
  return {
    cwd: `~/code/${partial.project}`,
    state: "idle",
    activity: "",
    waiting: null,
    model: "claude-opus-5",
    context: 42_000,
    permissionMode: "auto",
    title: null,
    summary: null,
    origin: "terminal",
    controllable: true,
    tmuxName: partial.project,
    lastActivity: now(),
    backgroundTasks: 0,
    itemCount: 0,
    ...partial,
  };
}

const item = (kind: Item["kind"], text: string, tool?: string, msAgo = 0): Item => ({ key: key(), kind, text, tool, ts: iso(msAgo) });

// The working session replays this loop so there is always something moving.
const WORK_LOOP: Array<Item | { state: SessionSummary["state"]; activity?: string }> = [
  { state: "working", activity: "Read signup.test.ts" },
  item("tool", "signup.test.ts", "Read"),
  item("assistant", "The test waits a fixed 500 ms for the confirmation email, which is flaky on a busy CI runner."),
  { state: "working", activity: "Edit signup.test.ts" },
  item("tool", "signup.test.ts", "Edit"),
  { state: "working", activity: "Bash Run the signup tests 20 times" },
  item("tool", "Run the signup tests 20 times", "Bash"),
  item("assistant", "20 of 20 runs pass now. The test waits for the email event instead of sleeping. Want me to commit it?"),
  { state: "idle" },
];

export class DemoHub extends Hub {
  private step = 0;
  private timer: Cancel | null = null;
  private partialCalls = 0;

  constructor() {
    super({ url: "demo", token: "" });
  }

  override async connect() {
    this.seed();
    this.connected = true;
    this.notify();
    if (!this.timer) this.timer = every(() => this.tick(), 3500);
  }

  override refresh() {
    this.notify();
  }

  private seed() {
    const a = session({ id: "00000000-0000-4000-8000-000000000001", project: "api-server", state: "working", title: "Fix the flaky signup test", activity: "Read auth.ts" });
    const b = session({
      id: "00000000-0000-4000-8000-000000000002",
      project: "mobile-app",
      state: "waiting",
      title: "Ship the onboarding redesign",
      waiting: { kind: "permission", tool: "Bash", detail: "Deploy the web build to staging" },
      lastActivity: now() - 60_000,
    });
    const c = session({ id: "00000000-0000-4000-8000-000000000003", project: "docs-site", title: "Rewrite the install guide", lastActivity: now() - 40 * 60_000 });
    for (const s of [a, b, c]) this.sessions.set(s.id, s);
    this.items.set(a.id, [
      item("user", "The signup test fails about one run in ten on CI. Find out why and fix it.", undefined, 300_000),
      item("assistant", "Looking at the signup flow and its test first.", undefined, 290_000),
      item("tool", "auth.ts", "Read", 280_000),
      item("tool", "mailer.ts", "Read", 270_000),
    ]);
    this.items.set(b.id, [
      item("user", "Build the web version and deploy it to staging so I can check it on my phone.", undefined, 120_000),
      item("tool", "Build the web bundle", "Bash", 100_000),
      item("assistant", "The build passed. Deploying to staging next.", undefined, 70_000),
      item("tool", "Deploy the web build to staging", "Bash", 60_000),
    ]);
    this.items.set(c.id, [
      item("user", "Rewrite the install guide so it starts with the one-line setup.", undefined, 50 * 60_000),
      item("assistant", "## Install\n\nThe guide now opens with the one-line setup, then covers:\n\n- requirements\n- pairing the glasses\n- troubleshooting", undefined, 40 * 60_000),
    ]);
  }

  private tick() {
    const id = "00000000-0000-4000-8000-000000000001";
    const s = this.sessions.get(id);
    const list = this.items.get(id);
    if (!s || !list) return;
    const next = WORK_LOOP[this.step % WORK_LOOP.length];
    this.step++;
    if ("state" in next) {
      s.state = next.state;
      s.activity = next.activity || "";
    } else {
      list.push({ ...next, key: key(), ts: iso() });
      if (list.length > 40) list.splice(0, list.length - 40);
    }
    s.lastActivity = now();
    this.notify();
  }

  private add(id: string, it: Item) {
    const list = this.items.get(id) || [];
    list.push(it);
    this.items.set(id, list);
  }

  override async loadItems(id: string) {
    if (!this.items.has(id)) this.items.set(id, []);
    this.notify();
  }

  override async prompt(id: string, text: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    this.add(id, item("user", text));
    s.state = "working";
    s.activity = "Thinking";
    this.notify();
    later(() => {
      this.add(id, item("assistant", "This is the demo, so nothing ran. Pair the app with your own machine to talk to real Claude Code sessions."));
      s.state = "idle";
      s.activity = "";
      s.lastActivity = now();
      this.notify();
    }, 1500);
    return {};
  }

  override async interrupt(id: string) {
    const s = this.sessions.get(id);
    if (s) {
      s.state = "idle";
      s.activity = "";
      this.add(id, item("notice", "Interrupted"));
      this.notify();
    }
    return {};
  }

  override async choose(id: string, _kind: "permission" | "question", index: number) {
    const s = this.sessions.get(id);
    const options = ["Yes", "Yes, and don't ask again for this command", "No"];
    if (!s?.waiting) throw new Error("nothing to answer");
    s.waiting = null;
    if (index === 2) {
      this.add(id, item("notice", "Interrupted"));
      s.state = "idle";
    } else {
      s.state = "working";
      later(() => {
        this.add(id, item("assistant", "Deployed to staging. Open staging.example.com on your phone to check the new onboarding."));
        s.state = "idle";
        s.lastActivity = now();
        this.notify();
      }, 1800);
    }
    this.notify();
    return { chosen: options[index] || "Yes" };
  }

  override async answer(id: string, text: string) {
    return this.prompt(id, text);
  }

  override async dialog(_id: string) {
    return { dialog: { kind: "permission", options: ["Yes", "Yes, and don't ask again for this command", "No"] } };
  }

  override async command(id: string, command: string) {
    this.add(id, item("notice", command));
    this.notify();
    return {};
  }

  override async recent(): Promise<{ projects: RecentProject[]; sessions: RecentSession[] }> {
    return {
      projects: ["api-server", "mobile-app", "docs-site", "infra"].map((p, i) => ({ cwd: `~/code/${p}`, project: p, mtime: now() - i * 3_600_000 })),
      sessions: [
        { id: "00000000-0000-4000-8000-000000000010", cwd: "~/code/infra", project: "infra", title: "Rotate the staging certificates", mtime: now() - 26 * 3_600_000 },
        { id: "00000000-0000-4000-8000-000000000011", cwd: "~/code/api-server", project: "api-server", title: "Add rate limits to the public API", mtime: now() - 50 * 3_600_000 },
      ],
    };
  }

  override async launch(cwd: string, resume?: string) {
    const project = cwd.split("/").pop() || "project";
    const s = session({ id: `00000000-0000-4000-8000-${String(now()).slice(-12)}`, project, title: resume ? "Resumed session" : null });
    this.sessions.set(s.id, s);
    this.items.set(s.id, [item("notice", resume ? "Resumed (demo)" : "New session (demo)")]);
    this.notify();
    return { session: s };
  }

  override presence() {
    return Promise.resolve();
  }

  override log(_message: string) {
    return Promise.resolve();
  }

  /** Voice in the demo: pretend the words arrive a few at a time while holding. */
  override async transcribe(_pcm: Uint8Array, partial = false): Promise<string> {
    const full = "Run the signup tests again and tell me what fails";
    await new Promise<void>((r) => later(r, partial ? 150 : 600));
    if (!partial) {
      this.partialCalls = 0;
      return full;
    }
    const words = full.split(" ");
    this.partialCalls = Math.min(words.length, this.partialCalls + 3);
    return words.slice(0, this.partialCalls).join(" ");
  }
}
