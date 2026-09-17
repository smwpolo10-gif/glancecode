# Security

GlanceCode lets a paired phone drive Claude Code and Codex sessions on your
computer, so security issues matter here. Please report them privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab,
"Report a vulnerability"). Please include steps to reproduce and the version
(`glancecode version`). You'll get a reply within a week.

Don't open a public issue for a security problem.

## Security model

- The hub API listens on 127.0.0.1. Phones reach it through `tailscale serve`,
  which terminates HTTPS on the machine's `*.ts.net` name and forwards to the hub.
- Every API request needs the pairing token (24 random bytes, compared in constant
  time). The token is stored in `~/.config/glancecode/config.json` with mode 600 and
  is never bundled into the glasses app.
- The Claude Code hook posts to a separate port on 127.0.0.1 that is never served
  over Tailscale.
- Keys are only sent to a Claude Code session after the matching dialog is read
  back from the terminal, and prompts are refused while a permission dialog is open.
- The Codex app server listens on a unix socket in `~/.config/glancecode`, created
  owner-only, and never on a network port. The hub answers only the Codex requests
  the glasses can show: command, file change and permission approvals, and
  questions. Anything else stays with the Codex terminal.

## Out of scope

- Anyone who already has the pairing token and access to your tailnet. That is
  the trust boundary by design.
- Claude Code's and Codex's own permission systems, which GlanceCode doesn't change.
- Other programs running as your user account. They can already run Codex and
  Claude Code directly.
