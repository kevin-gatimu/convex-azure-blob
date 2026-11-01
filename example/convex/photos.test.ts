/// <reference types="vite/client" />
import azureBlobTest from "convex-azure-blob/test";
import { AzureBlob } from "convex-azure-blob";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_FILE_BYTES } from "../upload-policy";
import { api, components, internal } from "./_generated/api";
import { azure } from "./photos";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%test");
const BLOCK = 8 * 1024 * 1024;
const ETAG = '"0x8DC0000000000001"';
const SNAPSHOT = "2026-01-01T12:00:00.0000000Z";
const EVENT_GRID_SECRET = "test-event-grid-secret-not-a-real-secret";
const blockId = (index: number) => btoa(String(index).padStart(8, "0"));

type Stored = { size: number; type: string; bytes: Uint8Array<ArrayBuffer> };
// What Azure "holds" per blob name; unlisted blobs default by extension.
const stored = new Map<string, Stored>();
const failures: { blockList?: number; commit?: number; snapshot?: number } = {};
const defaults = (name: string): Stored =>
  name.endsWith(".pdf")
    ? { size: PDF.length, type: "application/pdf", bytes: PDF }
    : { size: 8, type: "image/png", bytes: PNG };
const blobOf = (url: URL) => {
  const name = url.pathname.split("/").at(-1)!;
  return stored.get(name) ?? defaults(name);
};

// How an app tests code that uses the component: register it, set the env, stub Azure.
function initConvexTest() {
  const t = convexTest(schema, modules);
  azureBlobTest.register(t);
  return t;
}
type Client = ReturnType<ReturnType<typeof initConvexTest>["withIdentity"]>;

const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const requestUrl = String(url);
  if (requestUrl.includes("/oauth2/v2.0/token")) {
    return new Response(JSON.stringify({ access_token: "access-token" }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (requestUrl.includes("comp=userdelegationkey")) {
    const requestBody = String(init?.body);
    const start = /<Start>([^<]+)<\/Start>/.exec(requestBody)?.[1];
    const expiry = /<Expiry>([^<]+)<\/Expiry>/.exec(requestBody)?.[1];
    if (!start || !expiry) throw new Error("Missing delegation-key dates");
    return new Response(`<UserDelegationKey>
      <SignedOid>11111111-2222-3333-4444-555555555555</SignedOid>
      <SignedTid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</SignedTid>
      <SignedStart>${start}</SignedStart>
      <SignedExpiry>${expiry}</SignedExpiry>
      <SignedService>b</SignedService>
      <SignedVersion>2022-11-02</SignedVersion>
      <Value>dGVzdC1kZWxlZ2F0aW9uLWtleQ==</Value>
    </UserDelegationKey>`);
  }
  const blobUrl = new URL(requestUrl);
  const method = init?.method ?? "GET";
  const comp = blobUrl.searchParams.get("comp");
  const snapshot = blobUrl.searchParams.get("snapshot");
  if (method === "GET" && comp === "blocklist") {
    if (failures.blockList)
      return new Response(null, { status: failures.blockList });
    const blob = blobOf(blobUrl);
    const count = Math.ceil(blob.size / BLOCK);
    const blocks = Array.from({ length: count }, (_, i) => {
      const size = Math.min(BLOCK, blob.size - i * BLOCK);
      return `<Block><Name>${blockId(i)}</Name><Size>${size}</Size></Block>`;
    });
    // Reversed: the commit must still list ids in index order.
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?><BlockList><CommittedBlocks />` +
        `<UncommittedBlocks>${blocks.reverse().join("")}</UncommittedBlocks></BlockList>`,
    );
  }
  if (method === "PUT" && comp === "blocklist") {
    return failures.commit
      ? new Response(null, { status: failures.commit })
      : new Response(null, { status: 201, headers: { etag: ETAG } });
  }
  if (method === "PUT" && comp === "snapshot") {
    return new Response(null, {
      status: failures.snapshot ?? 201,
      headers: { "x-ms-snapshot": SNAPSHOT },
    });
  }
  switch (method) {
    case "HEAD": {
      // The blob only exists once committed, so the pre-commit probe is a 404.
      if (!snapshot) return new Response(null, { status: 404 });
      const blob = blobOf(blobUrl);
      return new Response(null, {
        headers: {
          "content-length": String(blob.size),
          "content-type": blob.type,
        },
      });
    }
    case "GET":
      return new Response(blobOf(blobUrl).bytes, { status: 206 });
    default:
      return new Response(null, { status: 202 });
  }
});

const blobNameOf = (ticket: { uploadUrl: string }) =>
  new URL(ticket.uploadUrl).pathname.split("/").at(-1)!;
function blobCreatedEvent(
  ticket: { uploadUrl: string },
  container = "uploads",
  eventType = "Microsoft.Storage.BlobCreated",
) {
  const url = new URL(ticket.uploadUrl);
  const blobName = url.pathname.split("/").filter(Boolean).slice(1).join("/");
  return {
    id: `event-${blobName}`,
    topic: "/subscriptions/test/resourceGroups/test",
    subject: `/blobServices/default/containers/${container}/blobs/${blobName}`,
    eventType,
    eventTime: "2026-01-01T12:00:00Z",
    data: {
      api: "PutBlockList",
      url: `${url.origin}/${container}/${blobName}`,
    },
    dataVersion: "1",
    metadataVersion: "1",
  };
}
function postEventGrid(
  client: Client,
  body: unknown,
  secret: string | null = EVENT_GRID_SECRET,
) {
  return client.fetch(
    `/azure-blob/events${secret === null ? "" : `?secret=${encodeURIComponent(secret)}`}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}
const blobCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => !String(url).includes("/oauth2/v2.0/token"))
    .map(([url, init]) => ({
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      init,
    }));

async function uploadPhoto(
  client: Client,
  contentType = "image/png",
  fileName = "cat.png",
  size = 8,
) {
  const ticket = await client.mutation(api.photos.generateUploadUrl, {
    contentType,
    fileName,
    size,
  });
  const result = await client.action(api.photos.confirmUpload, {
    fileId: ticket.fileId,
  });
  return { ticket, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AZURE_BLOB_ACCOUNT", "devstoreaccount1");
  vi.stubEnv("AZURE_BLOB_KEY", btoa("test-key"));
  vi.stubEnv("AZURE_BLOB_CONTAINER", "uploads");
  vi.stubEnv("AZURE_BLOB_EVENT_GRID_SECRET", EVENT_GRID_SECRET);
  vi.stubEnv(
    "AZURE_BLOB_ENDPOINT",
    "https://devstoreaccount1.blob.core.windows.net",
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockClear();
  stored.clear();
  delete failures.blockList;
  delete failures.commit;
  delete failures.snapshot;
});

describe("sweep continuation", () => {
  test("drains a full batch through the scheduled example action and accepts cron args", async () => {
    const t = initConvexTest();
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const ticket = await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "demo-user",
          size: PNG.length,
        }),
      );
      ids.push(ticket.fileId);
    }
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(await t.action(internal.photos.sweep, {})).toBe(100);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(blobCalls().filter((call) => call.method === "DELETE")).toHaveLength(
      101,
    );
    for (const id of ids)
      expect(await t.action((ctx) => azure.getFile(ctx, id))).toBeNull();
    expect(await t.action(internal.photos.sweep, { run: 9 })).toBe(0);
  });
});

describe("Event Grid confirmation", () => {
  test("answers the standard subscription validation handshake", async () => {
    const t = initConvexTest();
    const response = await postEventGrid(t, [
      {
        id: "validation",
        topic: "/subscriptions/test",
        subject: "",
        eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
        eventTime: "2026-01-01T12:00:00Z",
        data: { validationCode: "validation-code" },
        dataVersion: "1",
        metadataVersion: "1",
      },
    ]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      validationResponse: "validation-code",
    });
  });

  test("requires a configured high-entropy secret and rejects unauthenticated calls", async () => {
    expect(() => azure.eventGridHandler({ secret: "too-short" })).toThrow(
      "Event Grid secret must be at least 32 characters",
    );

    const t = initConvexTest();
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const response = await postEventGrid(t, [blobCreatedEvent(ticket)], null);
    const wrongSecret = await postEventGrid(
      t,
      [blobCreatedEvent(ticket)],
      `${EVENT_GRID_SECRET}-wrong`,
    );

    expect(response.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);
  });

  test("rejects malformed JSON and standard-schema event bodies", async () => {
    const t = initConvexTest();

    expect((await postEventGrid(t, "{")).status).toBe(400);
    expect((await postEventGrid(t, [{}])).status).toBe(400);

    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const invalidUrl = blobCreatedEvent(ticket);
    invalidUrl.data.url = "not-an-absolute-url";
    expect((await postEventGrid(t, [invalidUrl])).status).toBe(400);
  });

  test("acknowledges untracked blobs, other containers, and other event types", async () => {
    const t = initConvexTest();
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const untracked = blobCreatedEvent(ticket);
    untracked.data.url =
      "https://devstoreaccount1.blob.core.windows.net/uploads/not-tracked.png";
    const response = await postEventGrid(t, [
      untracked,
      blobCreatedEvent(ticket, "other-container"),
      blobCreatedEvent(ticket, "uploads", "Microsoft.Storage.BlobDeleted"),
    ]);

    expect(response.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);
  });

  test("does not confirm blobs outside the configured path prefix", async () => {
    const t = initConvexTest();
    const otherAzure = new AzureBlob(components.azureBlob, {
      blockUploads: true,
      pathPrefix: "other",
    });
    const ticket = await t.mutation((ctx) =>
      otherAzure.generateUploadUrl(ctx, {
        contentType: "image/png",
        size: 8,
        uploadedBy: "alice",
      }),
    );

    expect((await postEventGrid(t, [blobCreatedEvent(ticket)])).status).toBe(
      200,
    );
    expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);
  });

  test("confirms a BlobCreated event and attaches the photo once across retries", async () => {
    const t = initConvexTest().withIdentity({ subject: "alice" });
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const event = [blobCreatedEvent(ticket)];

    expect((await postEventGrid(t, event)).status).toBe(200);
    expect((await postEventGrid(t, event)).status).toBe(200);
    await expect(
      t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toMatchObject({ ok: true });

    const photos = await t.query(api.photos.list, {});
    expect(photos.map((photo) => photo.fileId)).toEqual([ticket.fileId]);
  });

  test("acknowledges an event after the browser has already confirmed", async () => {
    const t = initConvexTest().withIdentity({ subject: "alice" });
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });

    await expect(
      t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toMatchObject({ ok: true });
    expect((await postEventGrid(t, [blobCreatedEvent(ticket)])).status).toBe(
      200,
    );
    const photos = await t.query(api.photos.list, {});
    expect(photos.map((photo) => photo.fileId)).toEqual([ticket.fileId]);
  });

  test("returns a retryable status after a transient Azure failure", async () => {
    const t = initConvexTest();
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const event = [blobCreatedEvent(ticket)];
    failures.blockList = 503;
    const failed = await postEventGrid(t, event);

    expect(failed.status).toBe(503);
    expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);

    delete failures.blockList;
    expect((await postEventGrid(t, event)).status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toHaveLength(
      1,
    );
  });

  test.each(["commit", "snapshot"] as const)(
    "returns a retryable status after a transient Azure %s failure",
    async (stage) => {
      const t = initConvexTest();
      const ticket = await t.mutation(api.photos.generateUploadUrl, {
        contentType: "image/png",
        size: 8,
      });
      const event = [blobCreatedEvent(ticket)];
      failures[stage] = 503;

      expect((await postEventGrid(t, event)).status).toBe(503);
      expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);

      delete failures[stage];
      expect((await postEventGrid(t, event)).status).toBe(200);
      expect(
        await t.run((ctx) => ctx.db.query("photos").take(10)),
      ).toHaveLength(1);
    },
  );

  test.each(["commit", "snapshot"] as const)(
    "acknowledges a permanent Azure %s failure",
    async (stage) => {
      const t = initConvexTest();
      const ticket = await t.mutation(api.photos.generateUploadUrl, {
        contentType: "image/png",
        size: 8,
      });
      failures[stage] = 400;

      expect((await postEventGrid(t, [blobCreatedEvent(ticket)])).status).toBe(
        200,
      );
      expect(await t.run((ctx) => ctx.db.query("photos").take(10))).toEqual([]);
    },
  );

  test("commits the upload callback once when browser and Event Grid confirm concurrently", async () => {
    const t = initConvexTest().withIdentity({ subject: "alice" });
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    const [browserResult, eventResponse] = await Promise.all([
      t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
      postEventGrid(t, [blobCreatedEvent(ticket)]),
    ]);

    expect(browserResult).toMatchObject({ ok: true });
    expect(eventResponse.status).toBe(200);
    const photos = await t.query(api.photos.list, {});
    expect(photos.map((photo) => photo.fileId)).toEqual([ticket.fileId]);
  });
});

describe("photos", () => {
  test("upload, list with URLs, then delete", async () => {
    const t = initConvexTest().withIdentity({ subject: "alice" });
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      fileName: "cat.png",
      size: 8,
    });
    expect(ticket.uploadUrl).toMatch(
      /^https:\/\/devstoreaccount1\.blob\.core\.windows\.net\/uploads\/photos\/.+\.png\?.*sp=w/,
    );
    expect(ticket).toMatchObject({ kind: "blocks", blockSize: BLOCK });

    // The browser would stage the blocks; the stubbed Azure answers the commit steps.
    expect(
      await t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).toMatchObject({ ok: true });

    const calls = blobCalls();
    expect(
      calls.map(
        (c) =>
          `${c.method} ${c.url.searchParams.get("comp") ?? (c.url.searchParams.has("snapshot") ? "snapshot-read" : "blob")}`,
      ),
    ).toEqual([
      "GET blocklist",
      "HEAD blob",
      "PUT blocklist",
      "PUT snapshot",
      "HEAD snapshot-read",
      "GET snapshot-read",
    ]);
    const commit = calls[2]!.init!;
    expect(commit.headers).toMatchObject({
      "If-None-Match": "*",
      "x-ms-blob-content-type": "image/png",
    });
    expect(String(commit.body)).toContain(
      `<Uncommitted>${blockId(0)}</Uncommitted>`,
    );
    expect(calls[3]!.init!.headers).toMatchObject({ "If-Match": ETAG });
    expect(calls[3]!.url.searchParams.get("snapshot")).toBeNull();
    expect(calls[4]!.url.searchParams.get("snapshot")).toBe(SNAPSHOT);
    expect(calls[5]!.init!.headers).toMatchObject({ range: "bytes=0-63" });

    const [photo, ...rest] = await t.query(api.photos.list, {});
    expect(rest).toHaveLength(0);
    expect(photo).toMatchObject({
      fileId: ticket.fileId,
      fileName: "cat.png",
      size: 8,
    });
    expect(photo?.url).toContain("sp=r");
    expect(photo?.downloadUrl).toContain("rscd=");

    await t.mutation(api.photos.remove, { id: photo!.id });
    expect(await t.query(api.photos.list, {})).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const last = fetchMock.mock.calls.at(-1)?.[1];
    expect(last?.method).toBe("DELETE");
    expect(last?.headers).toMatchObject({ "x-ms-delete-snapshots": "include" });
  });

  test("forwards force to the internal refresh action and still accepts no args", async () => {
    vi.stubEnv("AZURE_BLOB_KEY", "");
    vi.stubEnv("AZURE_BLOB_TENANT_ID", "tenant");
    vi.stubEnv("AZURE_BLOB_CLIENT_ID", "client");
    vi.stubEnv("AZURE_BLOB_CLIENT_SECRET", "client-secret");
    const t = initConvexTest();
    const keyRequests = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("comp=userdelegationkey"),
      ).length;
    await t.action(internal.photos.refreshUserDelegationKey, {});
    expect(keyRequests()).toBe(1);
    await t.action(internal.photos.refreshUserDelegationKey, {});
    expect(keyRequests()).toBe(1);
    await t.action(internal.photos.refreshUserDelegationKey, { force: true });
    expect(keyRequests()).toBe(2);
  });

  test("uses a cached user delegation key in queries and bearer auth for Azure requests", async () => {
    vi.stubEnv("AZURE_BLOB_KEY", "");
    vi.stubEnv("AZURE_BLOB_TENANT_ID", "tenant");
    vi.stubEnv("AZURE_BLOB_CLIENT_ID", "client");
    vi.stubEnv("AZURE_BLOB_CLIENT_SECRET", "client-secret");
    const t = initConvexTest().withIdentity({ subject: "alice" });
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const ticket = await t.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    expect(new URL(ticket.uploadUrl).searchParams.get("skoid")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );

    await expect(
      t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toMatchObject({ ok: true });
    const blobRequests = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("/oauth2/v2.0/token"),
    );
    expect(
      blobRequests
        .filter(([, init]) => init?.method === "HEAD" || init?.method === "GET")
        .every(
          ([, init]) =>
            (init?.headers as Record<string, string>)?.authorization ===
            "Bearer access-token",
        ),
    ).toBe(true);

    fetchMock.mockClear();
    const [photo] = await t.query(api.photos.list, {});
    expect(photo?.url).toContain("skoid=");
    expect(photo?.downloadUrl).toContain("skoid=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("only the owner can delete a photo", async () => {
    const t = initConvexTest();
    const alice = t.withIdentity({ subject: "alice" });
    const { fileId } = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    await alice.action(api.photos.confirmUpload, { fileId });
    const [photo] = await alice.query(api.photos.list, {});
    await expect(
      t
        .withIdentity({ subject: "mallory" })
        .mutation(api.photos.remove, { id: photo!.id }),
    ).rejects.toThrow("Photo not found");
  });

  test("accepts a PDF whose signature matches", async () => {
    const alice = initConvexTest().withIdentity({ subject: "alice" });
    const { ticket, result } = await uploadPhoto(
      alice,
      "application/pdf",
      "spec.pdf",
      PDF.length,
    );
    expect(blobNameOf(ticket)).toMatch(/\.pdf$/);
    expect(result).toMatchObject({ ok: true, contentType: "application/pdf" });
    const [photo] = await alice.query(api.photos.list, {});
    expect(photo).toMatchObject({
      fileName: "spec.pdf",
      contentType: "application/pdf",
      size: PDF.length,
    });
    expect(photo?.downloadUrl).toContain("rscd=");
  });

  test("rejects a PDF with the wrong signature, deletes the blob and attaches nothing", async () => {
    const alice = initConvexTest().withIdentity({ subject: "alice" });
    const ticket = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "application/pdf",
      size: 9,
    });
    stored.set(blobNameOf(ticket), {
      size: 9,
      type: "application/pdf",
      bytes: new TextEncoder().encode("NOTAPDF!!"),
    });
    await expect(
      alice.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toEqual({
      ok: false,
      reason: "The file content does not match its type",
    });
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
    expect(await alice.query(api.photos.list, {})).toEqual([]);
  });

  test("commits a multi-block upload in index order", async () => {
    const alice = initConvexTest().withIdentity({ subject: "alice" });
    const size = 20 * 1024 * 1024;
    const ticket = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size,
    });
    stored.set(blobNameOf(ticket), { size, type: "image/png", bytes: PNG });
    await expect(
      alice.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toMatchObject({ ok: true, size });
    const commit = blobCalls().find(
      (c) =>
        c.method === "PUT" && c.url.searchParams.get("comp") === "blocklist",
    )!;
    expect(
      [...String(commit.init!.body).matchAll(/<Uncommitted>([^<]+)</g)].map(
        (m) => m[1],
      ),
    ).toEqual([blockId(0), blockId(1), blockId(2)]);
  });

  test("a batch of two files attaches each one independently", async () => {
    const alice = initConvexTest().withIdentity({ subject: "alice" });
    const [first, second] = await Promise.all([
      uploadPhoto(alice, "image/png", "a.png", 8),
      uploadPhoto(alice, "application/pdf", "b.pdf", PDF.length),
    ]);
    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);
    const list = await alice.query(api.photos.list, {});
    expect(list.map((p) => p.fileId).sort()).toEqual(
      [first.ticket.fileId, second.ticket.fileId].sort(),
    );
  });

  test("one failed file in a batch does not affect the other", async () => {
    const alice = initConvexTest().withIdentity({ subject: "alice" });
    const bad = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "application/pdf",
      size: 9,
    });
    stored.set(blobNameOf(bad), {
      size: 9,
      type: "application/pdf",
      bytes: new TextEncoder().encode("NOTAPDF!!"),
    });
    const good = await uploadPhoto(alice, "image/png", "ok.png", 8);
    const rejected = await alice.action(api.photos.confirmUpload, {
      fileId: bad.fileId,
    });
    expect(rejected.ok).toBe(false);
    const list = await alice.query(api.photos.list, {});
    expect(list.map((p) => p.fileId)).toEqual([good.ticket.fileId]);
  });

  test("lists only the caller's files", async () => {
    const t = initConvexTest();
    const alice = t.withIdentity({ subject: "alice" });
    const bob = t.withIdentity({ subject: "bob" });
    const a = await uploadPhoto(alice, "image/png", "alice.png");
    const b = await uploadPhoto(bob, "image/png", "bob.png");
    expect(
      (await alice.query(api.photos.list, {})).map((p) => p.fileId),
    ).toEqual([a.ticket.fileId]);
    expect((await bob.query(api.photos.list, {})).map((p) => p.fileId)).toEqual(
      [b.ticket.fileId],
    );
    expect(await t.query(api.photos.list, {})).toEqual([]);
  });

  test("only the uploader can confirm an upload", async () => {
    const t = initConvexTest();
    const alice = t.withIdentity({ subject: "alice" });
    const ticket = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
      size: 8,
    });
    await expect(
      t
        .withIdentity({ subject: "mallory" })
        .action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).resolves.toEqual({ ok: false, reason: "Unknown upload" });
    expect(await alice.query(api.photos.list, {})).toEqual([]);
  });

  describe("renewUploadUrl", () => {
    test("renews the owner's pending upload for the same blob", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      const ticket = await alice.mutation(api.photos.generateUploadUrl, {
        contentType: "image/png",
        size: 8,
      });
      const renewed = await alice.mutation(api.photos.renewUploadUrl, {
        fileId: ticket.fileId,
      });
      expect(renewed).toMatchObject({ fileId: ticket.fileId, kind: "blocks" });
      expect(new URL(renewed.uploadUrl).pathname).toBe(
        new URL(ticket.uploadUrl).pathname,
      );
    });

    test("refuses another user", async () => {
      const t = initConvexTest();
      const ticket = await t
        .withIdentity({ subject: "alice" })
        .mutation(api.photos.generateUploadUrl, {
          contentType: "image/png",
          size: 8,
        });
      await expect(
        t
          .withIdentity({ subject: "mallory" })
          .mutation(api.photos.renewUploadUrl, { fileId: ticket.fileId }),
      ).rejects.toThrow("Unknown upload");
    });

    test("refuses a file that is already confirmed", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      const { ticket } = await uploadPhoto(alice);
      await expect(
        alice.mutation(api.photos.renewUploadUrl, { fileId: ticket.fileId }),
      ).rejects.toThrow("Unknown upload");
    });
  });

  describe("refusals", () => {
    test("rejects a type outside the allowed list", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      await expect(
        alice.mutation(api.photos.generateUploadUrl, {
          contentType: "text/plain",
          size: 8,
        }),
      ).rejects.toThrow("This file type is not allowed");
    });

    test("rejects a size over the limit or a missing size", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      await expect(
        alice.mutation(api.photos.generateUploadUrl, {
          contentType: "image/png",
          size: MAX_FILE_BYTES + 1,
        }),
      ).rejects.toThrow("Invalid block upload size");
      await expect(
        alice.mutation(api.photos.generateUploadUrl, {
          contentType: "image/png",
        }),
      ).rejects.toThrow("Invalid block upload size");
    });

    test("expires a pending upload", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      const ticket = await alice.mutation(api.photos.generateUploadUrl, {
        contentType: "image/png",
        size: 8,
      });
      vi.advanceTimersByTime(10 * 60 * 1000);
      await expect(
        alice.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
      ).resolves.toEqual({ ok: false, reason: "Upload expired" });
      expect(await alice.query(api.photos.list, {})).toEqual([]);
    });
  });

  describe("Azure failures", () => {
    test("reports a missing block list as an upload that was not found", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      failures.blockList = 404;
      const { result } = await uploadPhoto(alice);
      expect(result).toEqual({ ok: false, reason: "Upload not found" });
    });

    test("fails when Azure refuses the block list", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      failures.blockList = 500;
      await expect(uploadPhoto(alice)).rejects.toThrow("block list failed");
    });

    test("reports a failed commit and attaches nothing", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      failures.commit = 409;
      const { result } = await uploadPhoto(alice);
      expect(result).toEqual({
        ok: false,
        reason: "Azure Blob commit failed with 409",
      });
      expect(await alice.query(api.photos.list, {})).toEqual([]);
    });

    test("rejects blocks whose total does not match the declared size", async () => {
      const alice = initConvexTest().withIdentity({ subject: "alice" });
      const ticket = await alice.mutation(api.photos.generateUploadUrl, {
        contentType: "image/png",
        size: 8,
      });
      stored.set(blobNameOf(ticket), {
        size: 16,
        type: "image/png",
        bytes: PNG,
      });
      await expect(
        alice.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
      ).resolves.toEqual({
        ok: false,
        reason: "The upload size does not match",
      });
    });
  });
});
