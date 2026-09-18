import { type GridCell, type TerminalHudSettings, type WidgetSize, SettingsStore } from "./settings.ts";

const CELLS: Array<{ value: GridCell; label: string }> = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "middle-left", label: "Middle left" },
  { value: "center", label: "Center" },
  { value: "middle-right", label: "Middle right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
];

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing settings control #${id}`);
  return node as T;
}

function checked(id: string): boolean {
  return byId<HTMLInputElement>(id).checked;
}

function value<T extends string>(id: string): T {
  return byId<HTMLSelectElement | HTMLInputElement>(id).value as T;
}

function numberValue(id: string): number {
  return Number(byId<HTMLInputElement | HTMLSelectElement>(id).value);
}

function makePositionGrids() {
  document.querySelectorAll<HTMLElement>("[data-position-grid]").forEach((grid) => {
    const input = byId<HTMLInputElement>(grid.dataset.positionGrid!);
    grid.replaceChildren(...CELLS.map(({ value, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "position-cell";
      button.dataset.value = value;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => {
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return button;
    }));
  });
}

function setPosition(id: string, position: GridCell) {
  const input = byId<HTMLInputElement>(id);
  input.value = position;
  const grid = document.querySelector<HTMLElement>(`[data-position-grid="${id}"]`);
  grid?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    const active = button.dataset.value === position;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function readForm(): TerminalHudSettings {
  return {
    version: 1,
    startView: value("start-view"),
    hud: {
      brightness: numberValue("brightness") as TerminalHudSettings["hud"]["brightness"],
      clock: {
        visible: checked("clock-visible"),
        hourCycle: value("hour-cycle"),
        showSeconds: checked("clock-seconds"),
        showPeriod: checked("clock-period"),
        position: value("clock-position"),
        size: value("clock-size"),
      },
      date: {
        visible: checked("date-visible"),
        format: value("date-format"),
        position: value("date-position"),
        size: value("date-size"),
      },
    },
    completion: {
      clockMode: value("completion-clock-mode"),
      pomodoroMode: value("completion-pomodoro-mode"),
      bellPlacement: value("completion-bell-placement"),
      detail: value("completion-detail"),
      bannerDurationSeconds: numberValue("completion-duration") as TerminalHudSettings["completion"]["bannerDurationSeconds"],
      position: value("completion-position"),
      size: value("completion-size"),
    },
    pomodoro: {
      workMinutes: numberValue("pomodoro-work"),
      shortBreakMinutes: numberValue("pomodoro-short-break"),
      longBreakMinutes: numberValue("pomodoro-long-break"),
      roundsBeforeLongBreak: numberValue("pomodoro-rounds"),
      breakLabel: value("pomodoro-break-label"),
      position: value("pomodoro-position"),
      size: value("pomodoro-size"),
    },
    sessions: {
      showTime: checked("sessions-time"),
      showDate: checked("sessions-date"),
      showHistory: checked("sessions-history"),
    },
    openTerminalOnLaunch: checked("open-terminal"),
  };
}

function assignForm(settings: TerminalHudSettings) {
  byId<HTMLSelectElement>("start-view").value = settings.startView;
  byId<HTMLSelectElement>("brightness").value = String(settings.hud.brightness);
  byId<HTMLInputElement>("clock-visible").checked = settings.hud.clock.visible;
  byId<HTMLSelectElement>("hour-cycle").value = settings.hud.clock.hourCycle;
  byId<HTMLInputElement>("clock-seconds").checked = settings.hud.clock.showSeconds;
  byId<HTMLInputElement>("clock-period").checked = settings.hud.clock.showPeriod;
  byId<HTMLSelectElement>("clock-size").value = settings.hud.clock.size;
  setPosition("clock-position", settings.hud.clock.position);
  byId<HTMLInputElement>("date-visible").checked = settings.hud.date.visible;
  byId<HTMLSelectElement>("date-format").value = settings.hud.date.format;
  byId<HTMLSelectElement>("date-size").value = settings.hud.date.size;
  setPosition("date-position", settings.hud.date.position);
  byId<HTMLSelectElement>("completion-clock-mode").value = settings.completion.clockMode;
  byId<HTMLSelectElement>("completion-pomodoro-mode").value = settings.completion.pomodoroMode;
  byId<HTMLSelectElement>("completion-bell-placement").value = settings.completion.bellPlacement;
  byId<HTMLSelectElement>("completion-detail").value = settings.completion.detail;
  byId<HTMLSelectElement>("completion-duration").value = String(settings.completion.bannerDurationSeconds);
  byId<HTMLSelectElement>("completion-size").value = settings.completion.size;
  setPosition("completion-position", settings.completion.position);
  byId<HTMLInputElement>("pomodoro-work").value = String(settings.pomodoro.workMinutes);
  byId<HTMLInputElement>("pomodoro-short-break").value = String(settings.pomodoro.shortBreakMinutes);
  byId<HTMLInputElement>("pomodoro-long-break").value = String(settings.pomodoro.longBreakMinutes);
  byId<HTMLInputElement>("pomodoro-rounds").value = String(settings.pomodoro.roundsBeforeLongBreak);
  byId<HTMLSelectElement>("pomodoro-break-label").value = settings.pomodoro.breakLabel;
  byId<HTMLSelectElement>("pomodoro-size").value = settings.pomodoro.size;
  setPosition("pomodoro-position", settings.pomodoro.position);
  byId<HTMLInputElement>("sessions-time").checked = settings.sessions.showTime;
  byId<HTMLInputElement>("sessions-date").checked = settings.sessions.showDate;
  byId<HTMLInputElement>("sessions-history").checked = settings.sessions.showHistory;
  byId<HTMLInputElement>("open-terminal").checked = settings.openTerminalOnLaunch;
  byId<HTMLInputElement>("clock-period").disabled = settings.hud.clock.hourCycle === "h24";
}

function previewClock(now: Date, settings: TerminalHudSettings): string {
  const formatted = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: settings.hud.clock.showSeconds ? "2-digit" : undefined,
    hour12: settings.hud.clock.hourCycle === "h12",
  }).format(now);
  return settings.hud.clock.showPeriod ? formatted : formatted.replace(/\s*[AP]M$/i, "");
}

function previewDate(now: Date, settings: TerminalHudSettings): string {
  const format = settings.hud.date.format;
  if (format === "numeric") return new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", year: "2-digit" }).format(now);
  if (format === "month-day") return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(now);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(now);
}

function widget(kind: string, text: string, position: GridCell, size: WidgetSize): HTMLDivElement {
  const node = document.createElement("div");
  node.className = `preview-widget ${kind} at-${position} size-${size}`;
  node.textContent = text;
  node.dataset.position = position;
  return node;
}

function oppositeCell(position: GridCell): GridCell {
  const opposite: Record<GridCell, GridCell> = {
    "top-left": "bottom-right", "top-center": "bottom-center", "top-right": "bottom-left",
    "middle-left": "middle-right", center: "top-right", "middle-right": "middle-left",
    "bottom-left": "top-right", "bottom-center": "top-center", "bottom-right": "top-left",
  };
  return opposite[position];
}

function addAlertPreview(
  nodes: HTMLElement[],
  settings: TerminalHudSettings,
  mode: "off" | "bell" | "banner",
  baseText: string,
  basePosition: GridCell,
  baseSize: WidgetSize,
  kind: "clock" | "timer",
) {
  if (mode === "bell") {
    if (settings.completion.bellPlacement === "opposite-corner") {
      nodes.push(widget("bell", "◆ 1", oppositeCell(basePosition), baseSize));
      nodes.push(widget(kind, baseText, basePosition, baseSize));
    } else {
      const text = settings.completion.bellPlacement === "before" ? `◆ 1  ${baseText}` : `${baseText}  ◆ 1`;
      nodes.push(widget(kind, text, basePosition, baseSize));
    }
    return;
  }
  nodes.push(widget(kind, baseText, basePosition, baseSize));
  if (mode === "banner") {
    const message = settings.completion.detail === "expanded" ? "√ Pillbee finished\nA moment ago" : "√ Pillbee finished";
    nodes.push(widget("completion", message, settings.completion.position, settings.completion.size));
  }
}

function renderPreview(settings: TerminalHudSettings) {
  const screen = byId<HTMLDivElement>("hud-preview-screen");
  const mode = document.querySelector<HTMLButtonElement>("[data-preview-mode].selected")?.dataset.previewMode || "hud";
  const nodes: HTMLElement[] = [];
  const now = new Date();
  if (mode === "pomodoro") {
    addAlertPreview(
      nodes,
      settings,
      settings.completion.pomodoroMode,
      `${String(settings.pomodoro.workMinutes).padStart(2, "0")}:00`,
      settings.pomodoro.position,
      settings.pomodoro.size,
      "timer",
    );
  } else {
    if (settings.hud.clock.visible) {
      addAlertPreview(nodes, settings, settings.completion.clockMode, previewClock(now, settings), settings.hud.clock.position, settings.hud.clock.size, "clock");
    } else if (settings.completion.clockMode === "bell") {
      nodes.push(widget("bell", "◆ 1", "top-right", "small"));
    } else if (settings.completion.clockMode === "banner") {
      const message = settings.completion.detail === "expanded" ? "√ Pillbee finished\nA moment ago" : "√ Pillbee finished";
      nodes.push(widget("completion", message, settings.completion.position, settings.completion.size));
    }
    if (settings.hud.date.visible) nodes.push(widget("date", previewDate(now, settings), settings.hud.date.position, settings.hud.date.size));
  }
  screen.replaceChildren(...nodes);
  screen.style.setProperty("--preview-brightness", String(0.25 + settings.hud.brightness * 0.1875));

  const occupied = new Map<string, number>();
  for (const node of nodes) occupied.set(node.dataset.position!, (occupied.get(node.dataset.position!) || 0) + 1);
  const overlaps = [...occupied.entries()].filter(([, count]) => count > 1).map(([position]) => CELLS.find((c) => c.value === position)?.label || position);
  const warning = byId<HTMLParagraphElement>("preview-warning");
  warning.hidden = overlaps.length === 0;
  warning.textContent = overlaps.length ? `These widgets share ${overlaps.join(", ")}. Pick another grid position if they cover each other.` : "";
}

/** Bind the phone settings editor to persistent Even Hub storage. */
export function bindSettingsUI(store: SettingsStore): () => void {
  makePositionGrids();
  const form = byId<HTMLFormElement>("settings-form");
  let assigning = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = store.subscribe((settings) => {
    assigning = true;
    assignForm(settings);
    assigning = false;
    renderPreview(settings);
  });

  form.addEventListener("input", () => {
    if (assigning) return;
    const next = readForm();
    renderPreview(next);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void store.update(next), 120);
  });
  form.addEventListener("change", () => {
    if (assigning) return;
    const next = readForm();
    assignForm(next);
    renderPreview(next);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void store.update(next), 60);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-preview-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("[data-preview-mode]").forEach((b) => b.classList.toggle("selected", b === button));
      renderPreview(store.current);
    });
  });

  const previewTick = setInterval(() => renderPreview(store.current), 1000);
  return () => {
    unsubscribe();
    clearInterval(previewTick);
    if (saveTimer) clearTimeout(saveTimer);
  };
}
