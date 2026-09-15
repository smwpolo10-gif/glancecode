import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version, name } = JSON.parse(readFileSync(new URL("./app.json", import.meta.url), "utf8"));
const built = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default defineConfig({
  base: "./",
  server: { host: true, port: 5173 },
  build: { target: "es2022", assetsInlineLimit: 0 },
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILT__: JSON.stringify(built), __APP_NAME__: JSON.stringify(name) },
});
