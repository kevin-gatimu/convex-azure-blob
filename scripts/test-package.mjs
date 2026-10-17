import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const minimumConvex = "1.46.0";
const minimumReact = "18.3.1";
assert.equal(manifest.peerDependencies.convex, `^${minimumConvex}`);
assert.ok(manifest.peerDependencies.react.startsWith(`^${minimumReact}`));
const consumer = await mkdtemp(join(tmpdir(), "convex-azure-blob-package-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:package");

function npm(args, cwd = consumer, capture = false) {
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
  const [packed] = JSON.parse(
    npm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer],
      root,
      true,
    ),
  );
  assert.ok(
    !packed.files.some(
      ({ path }) => path.startsWith(".env") || path.endsWith(".test.ts"),
    ),
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:./${packed.filename}`,
        convex: minimumConvex,
        react: minimumReact,
      },
      devDependencies: Object.fromEntries(
        [
          "@edge-runtime/vm",
          "@types/node",
          "@types/react",
          "convex-test",
          "typescript",
          "vite",
          "vitest",
        ].map((name) => [name, manifest.devDependencies[name]]),
      ),
    }),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node", "vite/client"],
      },
      include: ["smoke.test.ts"],
    }),
  );
  await writeFile(
    join(consumer, "smoke.test.ts"),
    `
import { describe, expect, it, vi } from "vitest";
import { AzureBlob, type UploadCallback } from "convex-azure-blob";
import { uploadToAzure, useUploadFile } from "convex-azure-blob/react";
import component from "convex-azure-blob/convex.config";
import componentJs from "convex-azure-blob/convex.config.js";
import componentTest from "convex-azure-blob/test";
import type { ComponentApi } from "convex-azure-blob/_generated/component";
import type { ComponentApi as ComponentApiJs } from "convex-azure-blob/_generated/component.js";
import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

describe("packed consumer on minimum Convex and React peers", () => {
  it("resolves the runtime exports and component config aliases", () => {
    expect(component).toBe(componentJs);
    expect(typeof uploadToAzure).toBe("function");
    expect(typeof useUploadFile).toBe("function");
  });
  it("registers the shipped component and commits an upload callback", async () => {
    const app = defineTestApp({
      schema: defineSchema({ attachments: defineTable({ fileId: v.string() }) }),
      components: { azureBlob: componentTest },
    });
    const reference: ComponentApi & ComponentApiJs = app.components.azureBlob;
    const azure = new AzureBlob(reference, {
      config: {
        accountName: "test", accountKey: btoa("test key"),
        container: "uploads", endpoint: "https://test.blob.core.windows.net",
      },
      verifyContent: false,
    });
    const callbacks = {
      attach: app.internalMutation({
        args: { fileId: v.string() },
        returns: v.null(),
        handler: async (ctx, args) => {
          await ctx.db.insert("attachments", args);
          return null;
        },
      }),
    };
    const { internal } = app.defineModules({ callbacks });
    const callback: UploadCallback = internal.callbacks.attach;
    const { api, createTest } = app.defineModules({
      callbacks,
      files: azure.clientApi({
        identify: async () => "user",
        onUpload: callback,
      }),
    });
    const t = createTest();
    const { fileId } = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
    });
    vi.stubGlobal("fetch", async () => new Response(null, {
      headers: { "content-length": "8", "content-type": "image/png" },
    }));
    try {
      expect((await t.action(api.files.confirmUpload, { fileId })).ok).toBe(true);
      await t.action(api.files.confirmUpload, { fileId });
      expect(await t.run((ctx) => ctx.db.query("attachments").take(2))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
`,
  );
  npm(["install", "--strict-peer-deps", "--no-audit", "--no-fund"]);
  for (const [name, version] of [
    ["convex", minimumConvex],
    ["react", minimumReact],
  ]) {
    const installed = JSON.parse(
      await readFile(
        join(consumer, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, version, `Expected minimum ${name} peer`);
  }
  npm(["exec", "--", "tsc", "--project", "tsconfig.json"]);
  npm([
    "exec",
    "--",
    "vitest",
    "run",
    "--environment",
    "edge-runtime",
    "smoke.test.ts",
  ]);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
