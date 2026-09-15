# Even Hub listing

Text and assets for the Even Hub submission.

**Name** (20 characters max): GlanceCode

**Short description:**
Your Claude Code sessions on your glasses. Watch progress, approve, and talk back.

**Description:**

GlanceCode shows the Claude Code sessions running on your computer and lets you
work with them from your G2.

- See every session and whether it's working, idle or waiting for you.
- Read the live transcript: replies, progress and tool calls.
- Approve or deny a tool call, or pick an answer to Claude's question.
- Hold to talk. Your words appear as you speak, and a tap sends them.
- Start a session in a recent project or resume an earlier one.
- Interrupt a session, compact it, or switch its model from the menu.

GlanceCode needs the free glancecode hub running on your Mac or Linux computer, and
Tailscale on the computer and the phone. Setup takes two commands:
`npm install -g glancecode` then `glancecode setup`. Everything stays on your own
computer and network, and voice is transcribed locally.

Not paired yet? Tap on the glasses to try a demo with sample sessions.

GlanceCode is an independent project and isn't affiliated with Anthropic.

**Permissions:**
- Glasses microphone: hold to talk. Audio goes only to the hub on your computer.
- Network: connects only to your own hub on your Tailscale network.

**Review notes:**
The app works without any setup through its built-in demo. Open the app, tap once
on the glasses, and every screen is available with sample sessions: the session
list, a working session, an approval (tap to approve), hold to talk, and the menu
(tap then hold). Double-tap on the session list exits.

**Screenshots:** `docs/screenshots/01-home.png` to `05-menu.png` (576×288).

**Privacy policy URL:** https://github.com/OWNER/glancecode/blob/main/docs/privacy.md

**Icon:** draw in the portal's 24×24 editor. Keep it to 2×2 pixel blocks.
