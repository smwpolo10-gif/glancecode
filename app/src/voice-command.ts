/**
 * Turn only explicit spoken slash syntax into a command. Ordinary prompts that
 * happen to mention "clear" or "resume" remain ordinary prompts.
 */
export function spokenSlashCommand(text: string): string | null {
  let value = text.trim().replace(/[.!?]+$/, "").trim();
  value = value.replace(/^(?:forward\s+)?slash\s+/i, "/");
  value = value.replace(/^\/\s+/, "/").replace(/\s+/g, " ").toLowerCase();
  if (!value.startsWith("/")) return null;

  if (["/clear", "/compact", "/context", "/cost", "/resume"].includes(value)) return value;
  const model = /^\/model (opus|sonnet|haiku|fable)$/.exec(value);
  return model ? `/model ${model[1]}` : null;
}
