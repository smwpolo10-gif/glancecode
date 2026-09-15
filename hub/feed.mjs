// Readable one-line-per-event feed of all sessions, for the terminal.
export function color(s, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export function printFeed(session, items) {
  const tag = color(String(session.project).padEnd(14).slice(0, 14), 36);
  for (const it of items) {
    const first = it.text.split("\n").find((l) => l.trim()) || "";
    const line = first.length > 110 ? first.slice(0, 109) + "…" : first;
    if (it.kind === "user") console.log(`${tag} ${color("›", 32)} ${color(line, 1)}`);
    else if (it.kind === "assistant") console.log(`${tag}   ${line}`);
    else if (it.kind === "tool") console.log(`${tag}   ${color(`▷ ${it.tool} ${it.text}`, 2)}`);
    else if (it.kind === "error") console.log(`${tag}   ${color(`! ${line}`, 31)}`);
    else console.log(`${tag}   ${color(`◇ ${line}`, 35)}`);
  }
}

export function printState(session, previous) {
  if (!previous || previous.state === session.state) return;
  const tag = color(String(session.project).padEnd(14).slice(0, 14), 36);
  if (session.state === "waiting") {
    const what = session.waiting?.kind === "question" ? "has a question" : `needs approval: ${session.waiting?.detail || ""}`;
    console.log(`${tag} ${color(`◆ ${what}`, 33)}`);
  } else if (session.state === "idle" && previous.state !== "starting") {
    console.log(`${tag} ${color("○ done", 2)}`);
  } else if (session.state === "ended") {
    console.log(`${tag} ${color("× ended", 2)}`);
  }
}
