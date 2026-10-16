/**
 * deploy.mjs — one-command deploy for the Connections backend Worker.
 *
 *   cd worker && npm install && npm run deploy
 *
 * Creates the KV namespace if missing, rewrites wrangler.toml with
 * the real namespace ID, then runs `wrangler deploy`. The public API is on Pages.
 * Requires the user to have run `wrangler login` (or set CLOUDFLARE_API_TOKEN).
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cmd) => execSync(cmd, { cwd: HERE, stdio: "pipe" }).toString().trim();
const run = (cmd) => execSync(cmd, { cwd: HERE, stdio: "inherit" });

console.log("Chess Connections backend deploy\n");

// 1. make sure wrangler is available + authenticated
try {
  sh("npx wrangler --version");
} catch {
  console.error("wrangler not found. Run `npm install` first.");
  process.exit(1);
}

try {
  console.log("checking Cloudflare auth...");
  sh("npx wrangler whoami");
} catch {
  console.error(
    "\nNot logged into Cloudflare.\n" +
    "  Run:  npx wrangler login\n" +
    "  (opens a browser to authorize, one-time)\n");
  process.exit(1);
}

// 2. create the KV namespace if it doesn't exist yet
const tomlPath = join(HERE, "wrangler.toml");
let toml = readFileSync(tomlPath, "utf8");
const idMatch = toml.match(/id = "([a-f0-9]+)"/);
let kvId = idMatch && idMatch[1] !== "REPLACE_WITH_KV_NAMESPACE_ID"
  ? idMatch[1] : null;

if (!kvId) {
  console.log("creating KV namespace 'GAMES_CACHE'...");
  try {
    const out = sh("npx wrangler kv namespace create GAMES_CACHE");
    // output contains: id = "abc123..."
    const m = out.match(/id\s*=\s*"([a-f0-9]+)"/);
    if (!m) throw new Error("couldn't parse namespace id from: " + out);
    kvId = m[1];
    toml = toml.replace(
      /id = "REPLACE_WITH_KV_NAMESPACE_ID"/,
      `id = "${kvId}"`
    );
    writeFileSync(tomlPath, toml);
    console.log(`created, id: ${kvId}`);
  } catch (e) {
    console.error("failed to create KV namespace:", e.message);
    process.exit(1);
  }
} else {
  console.log(`using existing KV namespace: ${kvId}`);
}

// 3. deploy
console.log("deploying worker...\n");
try {
  run("npx wrangler deploy");
} catch {
  process.exit(1);
}

// 4. Pages reaches the private Worker through its existing service binding.
console.log("\n------------------------------------------------");
console.log("deployed");
console.log("\n  Public API: https://tetizz-connections-api.pages.dev");
console.log("\n  Keep workers.dev and preview URLs disabled in wrangler.toml.");
console.log("------------------------------------------------\n");
