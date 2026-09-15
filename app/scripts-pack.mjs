// Build and pack the Even Hub app.
//
//   npm run pack                bump the patch version, build, pack ../glancecode.ehpk
//   npm run pack -- minor       bump minor (or major)
//   npm run pack -- --no-bump   pack the current version
//
// The Even portal replaces an upload with the same version without offering
// phones an update, so every upload should carry a new version.
//
// Personal builds: app.local.json (git-ignored) is merged over app.json, for
// example a different package_id or extra whitelist origins for a dev machine:
//   { "package_id": "com.example.myglance", "extraWhitelist": ["http://100.101.102.103:7717"] }
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const bump = args.includes("--no-bump") ? null : args.find((a) => a === "major" || a === "minor") || "patch";

const manifest = JSON.parse(readFileSync("app.json", "utf8"));
if (bump) {
  const [maj, min, pat] = manifest.version.split(".").map(Number);
  manifest.version = bump === "major" ? `${maj + 1}.0.0` : bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  writeFileSync("app.json", JSON.stringify(manifest, null, 2) + "\n");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  pkg.version = manifest.version;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
}

let packManifest = manifest;
let out = "../glancecode.ehpk";
if (existsSync("app.local.json")) {
  const local = JSON.parse(readFileSync("app.local.json", "utf8"));
  const { extraWhitelist = [], output, ...overrides } = local;
  packManifest = { ...manifest, ...overrides, version: manifest.version };
  packManifest.permissions = manifest.permissions.map((p) =>
    p.name === "network" ? { ...p, whitelist: [...(p.whitelist || []), ...extraWhitelist] } : p,
  );
  if (output) out = output;
  console.log(`using app.local.json overrides (${Object.keys(local).join(", ")})`);
}

console.log(`version ${manifest.version}`);
const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: "inherit" });
run("npx", ["tsc", "--noEmit"]);
run("npx", ["vite", "build"]);
const dir = mkdtempSync(join(tmpdir(), "glancecode-pack-"));
const manifestPath = join(dir, "app.json");
writeFileSync(manifestPath, JSON.stringify(packManifest, null, 2) + "\n");
try {
  run("npx", ["evenhub", "pack", manifestPath, "dist", "-o", out, "--sdk-ver", "0.0.15"]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nUpload ${out} (v${manifest.version}, ${packManifest.package_id}) at hub.evenrealities.com`);
