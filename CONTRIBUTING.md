# Contributing

Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/OWNER/glancecode.git
cd glancecode
npm run build:app
npm test
```

Run the hub from the checkout with `node bin/glancecode hub`. To keep a development
hub apart from an installed one, set `GLANCECODE_CONFIG_DIR`, `GLANCECODE_DATA_DIR` and
`GLANCECODE_TMUX_SOCKET` to scratch values and use different ports in that config.

## Testing the glasses app without glasses

```bash
cd app && npx vite --host 127.0.0.1
npx @evenrealities/evenhub-simulator --automation-port 9898 "http://127.0.0.1:5173/?demo"
```

The simulator's automation API takes input and screenshots:

```bash
curl -X POST 127.0.0.1:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
curl -o shot.png 127.0.0.1:9898/api/screenshot/glasses
```

Screenshots are RGBA with a transparent background. Composite them onto black
to view them.

## Guidelines

- The hub has no runtime dependencies. Please keep it that way.
- Anything that presses keys in a session must first confirm the expected dialog
  is on screen.
- Test against a real Claude Code session in a scratch folder and a scratch tmux
  socket, and never run `/model` against your real settings in a test.
- Glasses text must fit the 576×288 display. Use the helpers in `app/src/text.ts`.
