// Shapes shared with the hub (see hub/sessions.mjs and hub/transcript.mjs).

export type State = "starting" | "working" | "idle" | "waiting" | "ended";

/** Which coding agent a session runs. Hubs before Codex support leave it out. */
export type Agent = "claude" | "codex" | "gemini";

export interface Waiting {
  kind: "permission" | "question";
  tool?: string;
  detail?: string;
  questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[];
  questionIndex?: number;
}

export interface SessionSummary {
  id: string;
  agent?: Agent;
  project: string;
  cwd: string;
  state: State;
  activity: string;
  waiting: Waiting | null;
  model: string | null;
  /** The coding agent's current reasoning effort, such as low, high, or xhigh. */
  effort?: string | null;
  context: number | null;
  permissionMode: string | null;
  title: string | null;
  summary: string | null;
  origin: "terminal" | "glasses";
  controllable: boolean;
  tmuxName: string | null;
  /** Whether a visible Mac terminal is attached or waiting for Codex's first message. */
  terminalState?: "waiting" | "open" | null;
  lastActivity: number;
  backgroundTasks: number;
  itemCount: number;
}

export interface Item {
  key: string;
  kind: "user" | "assistant" | "tool" | "error" | "notice";
  text: string;
  tool?: string;
  ts?: string;
}

export interface RecentSession {
  id: string;
  agent?: Agent;
  cwd: string;
  project: string;
  title: string;
  mtime: number;
}

export interface ModelChoice {
  id: string;
  name: string;
  efforts?: string[];
  defaultEffort?: string | null;
}

export interface RecentProject {
  cwd: string;
  project: string;
  mtime: number;
}

export interface FinishedEvent {
  id: string;
  project: string;
  message: string;
  at: number;
}

export type HubEvent =
  | { type: "session"; session: SessionSummary }
  | { type: "items"; id: string; items: Item[] }
  | { type: "removed"; id: string }
  | ({ type: "finished" } & FinishedEvent)
  | { type: "resync" }
  | { type: "ping" };
