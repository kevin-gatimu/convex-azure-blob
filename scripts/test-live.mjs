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

// .env.example name -> the name live.test.ts reads (it reads only AZURE_LIVE_*).
const names = {
  AZURE_BLOB_ACCOUNT: "ACCOUNT",
  AZURE_BLOB_CONTAINER: "CONTAINER",
  AZURE_BLOB_ENDPOINT: "ENDPOINT",
  AZURE_BLOB_KEY: "KEY",
  AZURE_BLOB_TENANT_ID: "TENANT_ID",
  AZURE_BLOB_CLIENT_ID: "CLIENT_ID",
  AZURE_BLOB_CLIENT_SECRET: "CLIENT_SECRET",
  AZURE_BLOB_SHARED_KEY_ACCOUNT: "SHARED_KEY_ACCOUNT",
  AZURE_BLOB_SHARED_KEY_CONTAINER: "SHARED_KEY_CONTAINER",
  AZURE_BLOB_SHARED_KEY_ENDPOINT: "SHARED_KEY_ENDPOINT",
  AZURE_BLOB_SHARED_KEY: "SHARED_KEY",
  AZURE_BLOB_CORS_ORIGIN: "ORIGIN",
  AZURE_BLOB_COPY_SOURCE: "COPY_SOURCE",
};
for (const [from, to] of Object.entries(names)) {
  const value = process.env[from];
  // process.env stores undefined as the string "undefined", so copy only real values.
  if (value && !process.env[`AZURE_LIVE_${to}`])
    process.env[`AZURE_LIVE_${to}`] = value;
  // AzureBlob falls back to AZURE_BLOB_*, which would give the Entra suite the account key.
  delete process.env[from];
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
