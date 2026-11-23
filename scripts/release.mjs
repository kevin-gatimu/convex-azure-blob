import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Publishes the version already merged into package.json, then pushes only its tag:
// main is protected, so version bumps arrive through pull requests.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tag = `v${version}`;
const prerelease = version.match(/-([a-z]+)/i)?.[1];
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this with npm run release");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

if (git("status", "--porcelain")) fail("commit or stash your changes first.");
git("fetch", "--quiet", "--tags", "origin");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (!prerelease && branch !== "main")
  fail(`stable releases are published from main, not ${branch}.`);
let upstream = "";
try {
  upstream = git("rev-parse", `origin/${branch}`);
} catch {
  fail(`push ${branch} first, so the tag points at a commit on GitHub.`);
}
if (git("rev-parse", "HEAD") !== upstream)
  fail(`${branch} differs from origin/${branch}; pull or push first.`);
if (git("tag", "--list", tag))
  fail(`${tag} already exists; bump the version in a pull request first.`);

// prepublishOnly runs the full check before anything is uploaded.
const publish = spawnSync(
  process.execPath,
  [npmCli, "publish", ...(prerelease ? ["--tag", prerelease] : [])],
  { stdio: "inherit" },
);
if (publish.error) throw publish.error;
if (publish.status !== 0) process.exit(publish.status ?? 1);

git("tag", "-a", tag, "-m", `Release ${version}`);
execFileSync("git", ["push", "origin", tag], { stdio: "inherit" });
console.log(
  `release: published ${version}${prerelease ? ` as @${prerelease}` : ""} and pushed ${tag}.`,
);
