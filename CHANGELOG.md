# Changelog

## 0.4.1

- The hub keeps a plugged-in Mac awake, so a sleeping machine no longer looks
  like a dead hub from the glasses. Turn it off with `"preventSleep": false`.

## 0.4.0

- Removed the Plausible stats calendar feed (`glancecode stats`, `statsProducts`,
  `/api/stats.ics`). It had nothing to do with Claude Code sessions.

## 0.3.0 (glasses app 0.2.4)

- Terminal tabs show Claude Code's session title for sessions inside tmux.
- Voice: a transcript waits for a tap to send; it no longer sends by itself.
  Hold again to re-record, double-tap to cancel.
- Sessions no longer freeze on "Loading…" after opening the glasses menu or a
  dropped connection; the app recovers after the hub restarts and keeps the
  WebView awake while a working session is on screen.

## 0.2.0

First public release.

- Hub follows every Claude Code session through hooks and transcripts, and
  types into sessions that run inside tmux.
- Glasses app: session list, live transcript, approvals and questions with the
  real option labels, hold to talk with a live preview, new and resumed
  sessions, and a menu for interrupt, model switch and compact.
- Local speech to text with whisper.cpp.
- `glancecode setup`, `doctor`, `serve` (HTTPS through tailscale serve) and `pair`.
- Background service on macOS (launchd) and Linux (systemd user unit).
- Built-in demo in the glasses app, used before pairing.
- Optional Plausible stats as a subscribed calendar for the G2 dashboard.
