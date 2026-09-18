import type { BatteryFormat } from "./settings.ts";

export function normalizeBatteryLevel(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : null;
}

export function formatBattery(level: number | null, charging: boolean, format: BatteryFormat, showCharging: boolean): string | null {
  if (level === null) return null;
  const label = format === "label" ? `Bat ${level}%` : `${level}%`;
  return showCharging && charging ? `${label}+` : label;
}
