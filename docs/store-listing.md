# Even Hub listing

Text and assets for the Even Hub submission.

**Name** (20 characters max): GlanceCode

**Short description:**
Your Claude Code sessions on your glasses. Watch progress, approve, and talk back.

**Description:**

GlanceCode shows the Claude Code sessions running on your computer and lets you work with them from your G2, without hijacking the session.

- See every session and whether it's working, idle or waiting for you.
- Read the live transcript: replies, progress and tool calls.
- Approve or deny a tool call, or pick an answer to Claude's question.
- Hold to talk. Your words appear as you speak, and a tap sends them.
- Start a session in a recent project or resume an earlier one.
- Interrupt a session, compact it, or switch its model from the menu.
- Keep working in the same session from your glasses, your computer and the Claude app's remote connection at the same time. Nothing is copied or split, so you can switch devices whenever you like.

GlanceCode needs the free glancecode hub running on your Mac or Linux computer, and Tailscale on the computer and the phone. Setup takes two commands: `npm install -g @sousy/glancecode` then `glancecode setup`. Everything stays on your own computer and network, and voice is transcribed locally.

Not paired yet? Tap on the glasses to try a demo with sample sessions.

GlanceCode is an independent project and isn't affiliated with Anthropic.

Visit the project at:
- GitHub: https://github.com/sousyllc/glancecode
- NPM: https://www.npmjs.com/package/@sousy/glancecode
- Privacy: https://github.com/sousyllc/glancecode/blob/main/docs/privacy.md

**Permissions:**
- Glasses microphone: hold to talk. Audio goes only to the hub on your computer.
- Network: connects only to your own hub on your Tailscale network.

**Review notes:**
The app works without any setup through its built-in demo. Open the app, tap once
on the glasses, and every screen is available with sample sessions: the session
list, a working session, an approval (tap to approve), hold to talk, and the menu
(tap then hold). Double-tap on the session list exits.

**Screenshots:** `docs/screenshots/01-home.png` to `05-menu.png` (576×288, PNG with a
transparent background). Even Hub rejects solid black backgrounds, because the display
is see-through: black is the part you look through, and the portal previews the
screenshot over a blurred room photo. To rebuild them from a black-background capture:

```sh
magick shot.png -alpha off -separate -evaluate-sequence max \
  -morphology Dilate Octagon:1 -level 0%,70% mask.png
magick -size 576x288 xc:"#00FF00" mask.png -alpha off \
  -compose copy_opacity -composite out.png
```

The mask carries the text, dilated and brightened a little so the thin strokes stay
readable against a light background, and the color is the display's green.

**Privacy policy URL:** https://github.com/sousyllc/glancecode/blob/main/docs/privacy.md

**Icon:** draw in the portal's 24×24 editor. Keep it to 2×2 pixel blocks.
