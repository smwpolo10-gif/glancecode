export type PomodoroPhase = "focus" | "shortBreak" | "longBreak";

export interface PomodoroDurations {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  roundsBeforeLongBreak: number;
}

export interface PomodoroSnapshot {
  phase: PomodoroPhase;
  running: boolean;
  remainingMs: number;
  completedFocusRounds: number;
}

const clampMinutes = (value: number) => Math.max(1, Math.min(180, Math.round(value || 1)));

export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(seconds / 60);
  return `${String(mins).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function phaseLabel(phase: PomodoroPhase): string {
  return phase === "focus" ? "Focus" : phase === "shortBreak" ? "Short break" : "Long break";
}

/** Pomodoro state uses an absolute deadline so a sleeping WebView cannot lose time. */
export class PomodoroTimer {
  private phase: PomodoroPhase = "focus";
  private running = false;
  private remainingMs: number;
  private endsAt = 0;
  private completedFocusRounds = 0;
  private durations: PomodoroDurations;
  private changed: (reason?: "complete") => void;

  constructor(durations: PomodoroDurations, changed: (reason?: "complete") => void = () => {}) {
    this.durations = durations;
    this.changed = changed;
    this.remainingMs = this.durationFor("focus");
  }

  updateDurations(next: PomodoroDurations) {
    const wasPristine = !this.running && this.remainingMs === this.durationFor(this.phase);
    this.durations = next;
    if (wasPristine) this.remainingMs = this.durationFor(this.phase);
    this.changed();
  }

  snapshot(now = Date.now()): PomodoroSnapshot {
    this.tick(now);
    return {
      phase: this.phase,
      running: this.running,
      remainingMs: this.running ? Math.max(0, this.endsAt - now) : this.remainingMs,
      completedFocusRounds: this.completedFocusRounds,
    };
  }

  startPause(now = Date.now()) {
    this.tick(now);
    if (this.running) {
      this.remainingMs = Math.max(0, this.endsAt - now);
      this.running = false;
    } else {
      if (this.remainingMs <= 0) this.remainingMs = this.durationFor(this.phase);
      this.endsAt = now + this.remainingMs;
      this.running = true;
    }
    this.changed();
  }

  reset(now = Date.now()) {
    this.running = false;
    this.endsAt = now;
    this.remainingMs = this.durationFor(this.phase);
    this.changed();
  }

  skip(now = Date.now()) {
    this.advance(now, false);
    this.changed();
  }

  addMinutes(minutes: number, now = Date.now()) {
    const add = Math.max(1, Math.round(minutes)) * 60_000;
    if (this.running) this.endsAt += add;
    else this.remainingMs += add;
    this.changed();
  }

  /** Returns true only when this tick completed a phase. */
  tick(now = Date.now()): boolean {
    if (!this.running || now < this.endsAt) return false;
    this.advance(now, true);
    this.changed("complete");
    return true;
  }

  private advance(now: number, completed: boolean) {
    if (this.phase === "focus") {
      if (completed) this.completedFocusRounds++;
      const every = Math.max(1, Math.round(this.durations.roundsBeforeLongBreak || 1));
      this.phase = this.completedFocusRounds > 0 && this.completedFocusRounds % every === 0 ? "longBreak" : "shortBreak";
    } else {
      this.phase = "focus";
    }
    this.running = false;
    this.endsAt = now;
    this.remainingMs = this.durationFor(this.phase);
  }

  private durationFor(phase: PomodoroPhase) {
    const minutes = phase === "focus" ? this.durations.workMinutes : phase === "shortBreak" ? this.durations.shortBreakMinutes : this.durations.longBreakMinutes;
    return clampMinutes(minutes) * 60_000;
  }
}
