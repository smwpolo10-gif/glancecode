# Privacy policy

Last updated: 15 September 2026

GlanceCode is made of two parts: the hub, which you install and run on your own
computer, and the GlanceCode app for Even Realities G2 glasses. This policy covers
both.

## What the app handles

- **Session content.** The app shows your Claude Code sessions: prompts, replies,
  tool calls and status. It fetches them from the hub on your computer and keeps
  them in memory only while the app is open.
- **Voice.** When you hold to talk, audio from the glasses microphone is sent to
  the hub on your computer, which turns it into text with a speech model running
  locally. Audio isn't stored and isn't sent to any other service.
- **Pairing details.** The hub address and pairing token are saved in the Even
  Realities app's storage for GlanceCode, so you don't have to pair again.

## Where data goes

The app connects only to the hub address you paired with, over your own Tailscale
network. GlanceCode has no servers, accounts, analytics or tracking, and the
developer never receives your data.

The hub runs Claude Code on your computer. What Claude Code sends to Anthropic is
covered by your agreement with Anthropic, not by this policy.

If you turn on the optional phone notifications (`ntfyTopic`), the hub sends the
project name and a short status line to the ntfy server you configure.

## Removing your data

Choose "Forget this hub" in the app, uninstall the app, and remove the hub with
`glancecode service uninstall`, `glancecode uninstall` and `npm uninstall -g glancecode`.
Configuration lives in `~/.config/glancecode` and the speech model in
`~/.local/share/glancecode`; delete both folders to remove everything.

## Contact

Open an issue at https://github.com/OWNER/glancecode/issues.
