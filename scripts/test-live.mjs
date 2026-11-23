import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Only this script reads the env files, so `npm test` and CI never reach a real account.
// loadEnvFile keeps values already set, so the shell wins, then .env.local, then .env.
for (const name of [".env.local", ".env"]) {
  const file = fileURLToPath(new URL(`../${name}`, import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}

// The suite reads AZURE_LIVE_*; fill them from the app's AZURE_BLOB_* settings.
for (const name of [
  "ACCOUNT",
  "CONTAINER",
  "ENDPOINT",
  "KEY",
  "TENANT_ID",
  "CLIENT_ID",
  "CLIENT_SECRET",
]) {
  const value = process.env[`AZURE_BLOB_${name}`];
  // process.env stores undefined as the string "undefined", so copy only real values.
  if (value && !process.env[`AZURE_LIVE_${name}`])
    process.env[`AZURE_LIVE_${name}`] = value;
}
process.env.AZURE_LIVE = "1";

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [vitest, "run", "--typecheck", "src/client/live.test.ts"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
