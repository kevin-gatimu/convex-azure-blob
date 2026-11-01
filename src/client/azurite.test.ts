/// <reference types="vite/client" />
// Integration tests against a real Azurite blob emulator, which validates SAS signatures the way
// Azure does. They run only when AZURITE_BLOB_ENDPOINT is set:
//
//   docker compose up -d azurite && npm run azurite:setup
//   AZURITE_BLOB_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1 npm test
import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { describe, expect, it } from "vitest";
import componentTest, { register } from "../test.js";
import { AzureBlob } from "./index.js";
import { blockId } from "./blocks.js";
import { signBlobSas } from "./sas.js";

const endpoint = process.env.AZURITE_BLOB_ENDPOINT;
const config = {
  accountName: "devstoreaccount1",
  accountKey:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  container: process.env.AZURITE_CONTAINER ?? "uploads",
  endpoint: endpoint ?? "",
};
// A 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

function setup() {
  const t = convexTest(defineSchema({}), componentTest.modules);
  const azure = new AzureBlob(register(t), {
    config,
    pathPrefix: "integration",
  });
  return { t, azure };
}

async function browserUpload(
  azure: AzureBlob,
  t: ReturnType<typeof setup>["t"],
  body: BodyInit,
) {
  const ticket = await t.action((ctx) =>
    azure.generateUploadUrl(ctx, {
      contentType: "image/png",
      uploadedBy: "u1",
      fileName: "pixel ü.png",
    }),
  );
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: ticket.headers,
    body,
  });
  return { ticket, put };
}

describe.skipIf(!endpoint)("against Azurite", () => {
  it("sets and refreshes tiers using a real write SAS and denies a read SAS", async () => {
    const t = convexTest(defineSchema({}), componentTest.modules);
    const azure = new AzureBlob(register(t), { config, accessTier: "Cool" });
    const { ticket, put } = await browserUpload(azure, t, PNG);
    expect(put.status).toBe(201);
    try {
      expect(
        await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
      ).toMatchObject({ ok: true });
      expect(
        await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
      ).toMatchObject({ accessTier: "Cool" });
      const readUrl = await t.query((ctx) => azure.getUrl(ctx, ticket.fileId));
      const denied = new URL(readUrl!);
      denied.searchParams.set("comp", "tier");
      expect(
        (
          await fetch(denied, {
            method: "PUT",
            headers: {
              "x-ms-version": "2022-11-02",
              "x-ms-access-tier": "Hot",
            },
          })
        ).status,
      ).toBe(403);
      expect(
        await t.action((ctx) => azure.setTier(ctx, ticket.fileId, "Cold")),
      ).toBe(true);
      expect(
        await t.action((ctx) => azure.refreshTier(ctx, ticket.fileId)),
      ).toBe(true);
      expect(
        await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
      ).toMatchObject({ accessTier: "Cold" });
      expect(
        await t.action((ctx) => azure.setTier(ctx, ticket.fileId, "Archive")),
      ).toBe(true);
      expect(
        await t.action((ctx) => azure.refreshTier(ctx, ticket.fileId)),
      ).toBe(true);
      expect(
        await t.query((ctx) => azure.getUrl(ctx, ticket.fileId)),
      ).toBeNull();
      expect(
        await t.action((ctx) =>
          azure.rehydrate(ctx, ticket.fileId, {
            tier: "Hot",
            priority: "High",
          }),
        ),
      ).toBe(true);
      expect(
        await t.action((ctx) => azure.refreshTier(ctx, ticket.fileId)),
      ).toBe(true);
      expect(
        await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
      ).toMatchObject({ accessTier: "Hot" });
    } finally {
      expect(await t.action((ctx) => azure.purge(ctx, ticket.fileId))).toBe(
        true,
      );
    }
  });

  it("stages blocks and reads an immutable snapshot after the staging SAS overwrites the base", async () => {
    const t = convexTest(defineSchema({}), componentTest.modules);
    const azure = new AzureBlob(register(t), {
      config,
      blockUploads: true,
      pathPrefix: "integration",
    });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        size: PNG.length,
      }),
    );
    const stage = new URL(ticket.uploadUrl);
    stage.searchParams.set("comp", "block");
    stage.searchParams.set("blockid", blockId(0));
    expect((await fetch(stage, { method: "PUT", body: PNG })).status).toBe(201);
    expect((await fetch(ticket.uploadUrl)).status).toBe(403);
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toEqual({
      ok: true,
      size: PNG.length,
      contentType: "image/png",
    });
    const url = await t.action((ctx) =>
      azure.getUrl(ctx, ticket.fileId, { download: true }),
    );
    expect(new URL(url!).searchParams.get("sr")).toBe("bs");
    expect(new URL(url!).searchParams.has("snapshot")).toBe(true);
    expect(
      (
        await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: ticket.headers,
          body: "changed",
        })
      ).status,
    ).toBe(201);
    expect(new Uint8Array(await (await fetch(url!)).arrayBuffer())).toEqual(
      PNG,
    );
    const tampered = new URL(url!);
    tampered.searchParams.delete("snapshot");
    expect((await fetch(tampered)).status).toBe(403);
    expect((await fetch(url!, { method: "DELETE" })).status).toBe(403);
    expect(await t.action((ctx) => azure.purge(ctx, ticket.fileId))).toBe(true);
    expect((await fetch(url!)).status).toBe(404);
  });

  it("uses a tag-only SAS to gate reads on Defender's clean result", async () => {
    const t = convexTest(defineSchema({}), componentTest.modules);
    const azure = new AzureBlob(register(t), {
      config,
      requireMalwareScan: true,
    });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(
      (
        await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: ticket.headers,
          body: PNG,
        })
      ).status,
    ).toBe(201);
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true });
    expect(
      await t.action((ctx) => azure.getUrl(ctx, ticket.fileId)),
    ).toBeNull();

    const now = Date.now();
    const tagSas = await signBlobSas({
      accountName: config.accountName,
      accountKey: config.accountKey,
      container: config.container,
      blobName: new URL(ticket.uploadUrl).pathname.split("/").at(-1)!,
      permissions: "t",
      startsOn: now - 60_000,
      expiresOn: now + 5 * 60_000,
    });
    const tagsUrl = new URL(ticket.uploadUrl);
    tagsUrl.search = `comp=tags&${tagSas}`;
    expect(
      (
        await fetch(tagsUrl, {
          method: "PUT",
          headers: {
            "x-ms-version": "2022-11-02",
            "content-type": "application/xml",
          },
          body: "<Tags><TagSet><Tag><Key>Scan result</Key><Value>No threats found</Value></Tag></TagSet></Tags>",
        })
      ).status,
    ).toBe(204);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect(
      await t.action((ctx) => azure.getUrl(ctx, ticket.fileId)),
    ).not.toBeNull();
    expect(await t.action((ctx) => azure.purge(ctx, ticket.fileId))).toBe(true);
  });
  it("uploads with a create-only URL that cannot overwrite, then serves and downloads", async () => {
    const { t, azure } = setup();
    const { ticket, put } = await browserUpload(azure, t, PNG);
    expect(put.status).toBe(201);
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toEqual({
      ok: true,
      size: PNG.length,
      contentType: "image/png",
    });
    const overwrite = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: ticket.headers,
      body: "evil",
    });
    expect(overwrite.status).toBe(403);

    const url = await t.action((ctx) => azure.getUrl(ctx, ticket.fileId));
    const read = await fetch(url ?? "");
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);
    expect((await fetch(url ?? "", { method: "DELETE" })).status).toBe(403);

    const download = await t.action((ctx) =>
      azure.getUrl(ctx, ticket.fileId, {
        download: true,
        cacheControl: "private, max-age=60",
      }),
    );
    const downloaded = await fetch(download ?? "");
    expect(downloaded.headers.get("content-disposition")).toContain(
      "UTF-8''pixel%20%C3%BC.png",
    );
    expect(downloaded.headers.get("cache-control")).toBe("private, max-age=60");

    const tampered = new URL(url ?? "");
    tampered.searchParams.set("sp", "rd");
    expect((await fetch(tampered, { method: "DELETE" })).status).toBe(403);

    expect(await t.action((ctx) => azure.purge(ctx, ticket.fileId))).toBe(true);
    expect((await fetch(url ?? "")).status).toBe(404);
  });

  it("rejects and deletes a blob whose bytes are not the declared type", async () => {
    const { t, azure } = setup();
    const { ticket, put } = await browserUpload(
      azure,
      t,
      "<svg onload=alert(1)>",
    );
    expect(put.status).toBe(201);
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toEqual({
      ok: false,
      reason: "The file content does not match its type",
    });
    const file = await t.action((ctx) => azure.getFile(ctx, ticket.fileId));
    expect(file?.status).toBe("deleting");
  });

  it("stores from the server and sweeps the result", async () => {
    const { t, azure } = setup();
    const stored = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(
      await t.action((ctx) => azure.markForDeletion(ctx, stored.fileId)),
    ).toBe(true);
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
  });
});
