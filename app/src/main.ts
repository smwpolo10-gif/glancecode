// Must stay the first import: it captures the browser timers before the SDK replaces them.
import { every, timersPatched } from "./timers.ts";
import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { App } from "./app.ts";
import { DemoHub } from "./demo.ts";
import { Display } from "./display.ts";
import { Hub, type HubConfig } from "./hub.ts";
import { InputRouter, type Action } from "./input.ts";
import { BODY_INNER_W, HEADER_INNER_W } from "./display.ts";
import { spread, wrap } from "./text.ts";

const KEY = "glancecode.hub";
const LEGACY_KEYS: string[] = [];
declare const __APP_VERSION__: string;
declare const __APP_BUILT__: string;
declare const __APP_NAME__: string;
export const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
const APP_NAME = typeof __APP_NAME__ === "string" ? __APP_NAME__ : "GlanceCode";

async function readConfig(bridge: EvenAppBridge): Promise<HubConfig | null> {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token") ? { url: params.get("hub") || location.origin, token: params.get("token")! } : null;
  if (fromUrl) {
    await bridge.setLocalStorage(KEY, JSON.stringify(fromUrl)).catch(() => false);
    history.replaceState(null, "", location.pathname); // keep the token out of the address bar
    return fromUrl;
  }
  for (const k of [KEY, ...LEGACY_KEYS]) {
    const stored = await bridge.getLocalStorage(k).catch(() => "");
    if (!stored) continue;
    try {
      const cfg = JSON.parse(stored) as HubConfig;
      if (cfg.url && cfg.token) return cfg;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function parsePairing(code: string): HubConfig | null {
  const m = /^\s*(https?:\/\/[^\s#]+)#(\S+)\s*$/.exec(code);
  return m ? { url: m[1].replace(/\/$/, ""), token: m[2] } : null;
}

function el<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

async function main() {
  const bridge = await waitForEvenAppBridge();
  const cfg = await readConfig(bridge);
  const demo = new URLSearchParams(location.search).has("demo");

  const status = el<HTMLSpanElement>("status");
  const mirror = el<HTMLPreElement>("mirror");
  const pairForm = el<HTMLFormElement>("pair");
  const pairInput = el<HTMLInputElement>("pair-code");
  const demoButton = el<HTMLButtonElement>("demo");
  const unpairButton = el<HTMLButtonElement>("unpair");
  el<HTMLSpanElement>("version").textContent = `v${VERSION} · built ${typeof __APP_BUILT__ === "string" ? __APP_BUILT__ : "dev"}`;

  pairForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsed = parsePairing(pairInput.value);
    if (!parsed) {
      status.textContent = "That doesn't look like a pairing code. It starts with https:// and has a # before the token.";
      return;
    }
    await bridge.setLocalStorage(KEY, JSON.stringify(parsed));
    location.href = location.pathname;
  });
  unpairButton.addEventListener("click", async () => {
    await bridge.setLocalStorage(KEY, "");
    for (const k of LEGACY_KEYS) await bridge.setLocalStorage(k, "").catch(() => false);
    location.href = location.pathname;
  });

  const display = new Display(bridge);
  display.onFrame = (f) => {
    mirror.textContent = `${f.header}\n${"─".repeat(40)}\n${f.body.join("\n")}`;
  };

  let started = false;
  const start = async (hub: Hub) => {
    if (started) return;
    started = true;
    const app = new App(bridge, display, hub);
    router.target = (a) => void app.handle(a);
    hub.subscribe(() => {
      if (hub instanceof DemoHub) status.textContent = "Demo mode: sample sessions, nothing runs. Pair to use your own machine.";
      else status.textContent = hub.connected ? `Connected to ${hub.cfg.url} · ${hub.sessions.size} session(s)` : `Hub unreachable at ${hub.cfg.url}${hub.lastError ? ` (${hub.lastError})` : ""}`;
    });
    await hub.connect();
    void hub.presence();
    every(() => void hub.presence(), 30_000);
    if (timersPatched()) void hub.log("timers: SDK shadow timers active, using native timers alongside");
  };

  // Until a hub is chosen, a tap on the glasses starts the demo.
  const router: { target: (a: Action) => void } = {
    target: (a) => {
      if (a.type === "tap") void startDemo();
      if (a.type === "doubleTap") void bridge.shutDownPageContainer(1);
    },
  };
  const input = new InputRouter((a) => router.target(a), () => display.lastWriteAt);
  bridge.onEvenHubEvent((ev) => input.handle(ev));

  const startDemo = async () => {
    pairForm.hidden = true;
    demoButton.hidden = true;
    unpairButton.hidden = true;
    await start(new DemoHub());
  };
  demoButton.addEventListener("click", () => void startDemo());

  if (cfg && !demo) {
    demoButton.hidden = true;
    await start(new Hub(cfg));
    return;
  }
  if (demo) {
    await startDemo();
    return;
  }
  unpairButton.hidden = true;
  pairForm.hidden = false;
  demoButton.hidden = false;
  status.textContent = "Not paired. On your computer run `glancecode pair` and paste the code below, or try the demo.";
  display.show({
    header: spread(APP_NAME, "not paired", HEADER_INNER_W),
    body: wrap(
      "Pair with the hub on your computer: run glancecode pair and paste the code on your phone.\n\nTap to try the demo with sample sessions.\nDouble-tap to exit.",
      BODY_INNER_W,
    ),
  });
}

main().catch((err) => {
  console.error(err);
  const status = document.getElementById("status");
  if (status) status.textContent = `Error: ${err?.message || err}`;
});
