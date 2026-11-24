import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run lint:package");
const dest = await mkdtemp(join(tmpdir(), "convex-azure-blob-storage-lint-"));

function npm(args, capture = false, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm ${args.join(" ")} failed`);
  return result.stdout;
}

try {
  // npm silently rewrites fields it would fix at publish time; keep package.json already fixed.
  const fixDir = join(dest, "pkg-fix");
  await mkdir(fixDir);
  await copyFile(join(root, "package.json"), join(fixDir, "package.json"));
  npm(["pkg", "fix"], false, fixDir);
  assert.deepStrictEqual(
    JSON.parse(await readFile(join(fixDir, "package.json"), "utf8")),
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    "package.json has fields npm would rewrite on publish; run npm pkg fix",
  );

  const [packed] = JSON.parse(
    npm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", dest],
      true,
    ),
  );
  const tarball = join(dest, packed.filename);
  npm(["exec", "--", "publint", "--strict", tarball]);
  // ESM-only package: CommonJS and node10 resolution are intentionally unsupported.
  npm(["exec", "--", "attw", tarball, "--profile", "esm-only"]);
} finally {
  await rm(dest, { recursive: true, force: true });
}
