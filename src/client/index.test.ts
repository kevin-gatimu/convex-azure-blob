/// <reference types="vite/client" />
import { convexTest, defineTestApp } from "convex-test";
import { defineSchema } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import componentTest, { register } from "../test.js";
import { AzureBlob } from "./index.js";
import type { AzureBlobOptions, FileDoc } from "./index.js";

const config = {
  accountName: "devstoreaccount1",
  // Azurite's published development key, so not a secret.
  accountKey:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  container: "uploads",
  endpoint: "http://127.0.0.1:10000/devstoreaccount1",
};
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

function setup(options: AzureBlobOptions = {}) {
  const t = convexTest(defineSchema({}), componentTest.modules);
  const component = register(t);
  let now = T0;
  const azure = new AzureBlob(component, {
    config,
    now: () => now,
    ...options,
  });
  const reserve = async (
    args: { maxBytes?: number; uploadedBy?: string; fileName?: string } = {},
  ) =>
    (
      await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          ...args,
        }),
      )
    ).fileId;
  const upload = async (args: Parameters<typeof reserve>[0] = {}) => {
    const fileId = await reserve(args);
    stubBlob({});
    const result = await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    expect(result.ok).toBe(true);
    fetchMock.mockClear();
    return fileId;
  };
  return {
    t,
    azure,
    reserve,
    upload,
    file: (fileId: string) => t.action((ctx) => azure.getFile(ctx, fileId)),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Blob = {
  status?: number;
  length?: number;
  type?: string;
  bytes?: Uint8Array<ArrayBuffer>;
};
const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

function stubBlob(blob: Blob, deleteStatus = 202) {
  fetchMock.mockImplementation(async (_url, init) => {
    const method = init?.method ?? "GET";
    if (method === "HEAD") {
      return new Response(null, {
        status: blob.status ?? 200,
        headers: {
          "content-length": String(blob.length ?? 1000),
          "content-type": blob.type ?? "image/png",
        },
      });
    }
    if (method === "GET")
      return new Response(blob.bytes ?? PNG, { status: 206 });
    if (method === "DELETE")
      return new Response(null, { status: deleteStatus });
    return new Response(null, { status: 201 });
  });
}

const methods = () =>
  fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET");
const params = (url: string | null | undefined) =>
  new URL(url ?? "http://x").searchParams;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constructor", () => {
  it("rejects a path prefix that could escape or confuse the blob path", () => {
    const component = {} as never;
    for (const pathPrefix of ["../x", "/x", "x/", "a//b", "a b", "a?b", ""]) {
      expect(() => new AzureBlob(component, { pathPrefix })).toThrow(
        "Invalid pathPrefix",
      );
    }
    expect(
      () => new AzureBlob(component, { pathPrefix: "users/avatars" }),
    ).not.toThrow();
  });
});

describe("generateUploadUrl", () => {
  it("returns a create-only URL for one server-named blob with a short expiry", async () => {
    const { t, azure, file } = setup();
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "Image/PNG; charset=x",
        uploadedBy: "u1",
      }),
    );
    const url = new URL(ticket.uploadUrl);
    expect(url.origin + url.pathname).toMatch(
      /^http:\/\/127\.0\.0\.1:10000\/devstoreaccount1\/uploads\/[0-9a-f-]{36}\.png$/,
    );
    expect(url.searchParams.get("sp")).toBe("c");
    expect(url.searchParams.get("sr")).toBe("b");
    expect(url.searchParams.get("se")).toBe("2026-01-01T12:05:00Z");
    expect(url.searchParams.has("spr")).toBe(false);
    expect(ticket.uploadUrl).not.toContain(config.accountKey);
    expect(ticket.headers).toEqual({
      "x-ms-blob-type": "BlockBlob",
      "content-type": "image/png",
    });
    const row = await file(ticket.fileId);
    expect(row).toMatchObject({
      status: "pending",
      uploadedBy: "u1",
      contentType: "image/png",
      container: "uploads",
    });
    expect(url.pathname.endsWith(row?.blobName ?? "?")).toBe(true);
  });

  it("puts blobs under the path prefix and keeps the slash unencoded", async () => {
    const { t, azure } = setup({ pathPrefix: "users/avatars" });
    const { uploadUrl } = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(new URL(uploadUrl).pathname).toMatch(
      /\/uploads\/users\/avatars\/[0-9a-f-]{36}\.png$/,
    );
  });

  it("signs https-only URLs for an https endpoint", async () => {
    const { t, azure } = setup({
      config: { ...config, endpoint: "https://acct.blob.core.windows.net" },
    });
    const { uploadUrl } = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(uploadUrl).get("spr")).toBe("https");
  });

  it("rejects content types outside the allow-list", async () => {
    const { t, azure } = setup();
    for (const contentType of [
      "image/svg+xml",
      "text/html",
      "application/pdf",
      "",
    ]) {
      await expect(
        t.action((ctx) =>
          azure.generateUploadUrl(ctx, { contentType, uploadedBy: "u1" }),
        ),
      ).rejects.toThrow("not allowed");
    }
  });

  it("accepts a custom allow-list", async () => {
    const { t, azure } = setup({
      allowedContentTypes: { "application/pdf": "pdf" },
    });
    const { uploadUrl } = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "application/pdf",
        uploadedBy: "u1",
      }),
    );
    expect(new URL(uploadUrl).pathname).toMatch(/\.pdf$/);
  });

  it("never lets a caller raise the size ceiling", async () => {
    const { reserve, file } = setup({ maxBytes: 100 });
    expect((await file(await reserve({ maxBytes: 1e9 })))?.maxBytes).toBe(100);
  });

  it("refuses a reported size over the limit before reserving", async () => {
    const { t, azure } = setup({ maxBytes: 100 });
    await expect(
      t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          size: 101,
        }),
      ),
    ).rejects.toThrow("too large");
  });

  it("stores the file name and metadata, and validates them", async () => {
    const { t, azure, file } = setup();
    const { fileId } = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        fileName: "Holiday ☀️.png",
        metadata: { album: "summer" },
      }),
    );
    expect(await file(fileId)).toMatchObject({
      fileName: "Holiday ☀️.png",
      metadata: { album: "summer" },
    });
    await expect(
      t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          fileName: "x".repeat(256),
        }),
      ),
    ).rejects.toThrow("File names");
    await expect(
      t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          metadata: Object.fromEntries(
            Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]),
          ),
        }),
      ),
    ).rejects.toThrow("Metadata");
  });
});

describe("confirmUpload", () => {
  it("marks the file ready after a HEAD and a 64-byte ranged read, both read-only", async () => {
    const { t, azure, reserve, file } = setup();
    const fileId = await reserve({ maxBytes: 2000 });
    stubBlob({ length: 1500 });
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: true,
      size: 1500,
      contentType: "image/png",
    });
    expect(methods()).toEqual(["HEAD", "GET"]);
    for (const [url] of fetchMock.mock.calls)
      expect(params(String(url)).get("sp")).toBe("r");
    const [, get] = fetchMock.mock.calls[1] ?? [];
    expect(get?.headers).toEqual({ range: "bytes=0-63" });
    expect((await file(fileId))?.size).toBe(1500);
  });

  it("rejects a blob whose bytes do not match the declared type", async () => {
    const { t, azure, reserve, file } = setup();
    const fileId = await reserve();
    stubBlob({
      bytes: new TextEncoder().encode("<html><script>alert(1)</script>"),
    });
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: false,
      reason: "The file content does not match its type",
    });
    expect(methods()).toEqual(["HEAD", "GET", "DELETE"]);
    expect((await file(fileId))?.status).toBe("deleting");
  });

  it("skips the content check when disabled", async () => {
    const { t, azure, reserve } = setup({ verifyContent: false });
    const fileId = await reserve();
    stubBlob({ bytes: new TextEncoder().encode("not a png") });
    expect((await t.action((ctx) => azure.confirmUpload(ctx, fileId))).ok).toBe(
      true,
    );
    expect(methods()).toEqual(["HEAD"]);
  });

  it("skips the content check for types without a known signature", async () => {
    const { t, azure } = setup({ allowedContentTypes: { "text/csv": "csv" } });
    const { fileId } = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "text/csv",
        uploadedBy: "u1",
      }),
    );
    stubBlob({ type: "text/csv" });
    expect((await t.action((ctx) => azure.confirmUpload(ctx, fileId))).ok).toBe(
      true,
    );
    expect(methods()).toEqual(["HEAD"]);
  });

  it("deletes the blob when it is too large", async () => {
    const { t, azure, reserve, file } = setup();
    const fileId = await reserve({ maxBytes: 1000 });
    stubBlob({ length: 5000 });
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: false,
      reason: "The file is too large",
    });
    expect(methods()).toEqual(["HEAD", "DELETE"]);
    expect(params(String(fetchMock.mock.calls[1]?.[0])).get("sp")).toBe("d");
    expect((await file(fileId))?.status).toBe("deleting");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
  });

  it("rejects an empty blob", async () => {
    const { t, azure, reserve } = setup();
    const fileId = await reserve();
    stubBlob({ length: 0 });
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: false,
      reason: "The file is empty",
    });
  });

  it("rejects a blob stored with another content type than reserved", async () => {
    const { t, azure, reserve } = setup();
    for (const type of ["text/html", "image/gif"]) {
      const fileId = await reserve();
      stubBlob({ type });
      expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual(
        {
          ok: false,
          reason: "This file type is not allowed",
        },
      );
    }
  });

  it("keeps a missing upload pending so the browser can retry", async () => {
    const { t, azure, reserve, file } = setup();
    const fileId = await reserve();
    stubBlob({ status: 404 });
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: false,
      reason: "Upload not found",
    });
    expect((await file(fileId))?.status).toBe("pending");
  });

  it("throws on an unexpected Azure error so the caller can retry", async () => {
    const { t, azure, reserve } = setup();
    const fileId = await reserve();
    stubBlob({ status: 503 });
    await expect(
      t.action((ctx) => azure.confirmUpload(ctx, fileId)),
    ).rejects.toThrow("503");
  });

  it("is a no-op for a file that is already ready, and refuses unknown ids", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    const again = await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    expect(again).toMatchObject({ ok: true, size: 1000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, "not-an-id")),
    ).toEqual({
      ok: false,
      reason: "Unknown upload",
    });
  });
});

describe("getUrl", () => {
  it("is null until the upload is confirmed", async () => {
    const { t, azure, reserve } = setup();
    const fileId = await reserve();
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
  });

  it("signs a read-only URL that is stable inside a window and expires within two", async () => {
    const { t, azure, upload, advance } = setup();
    const fileId = await upload();
    const first = await t.action((ctx) => azure.getUrl(ctx, fileId));
    advance(MINUTE);
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBe(first);
    expect(params(first).get("sp")).toBe("r");
    expect(params(first).get("se")).toBe("2026-01-01T14:00:00Z");
    expect(params(first).get("st")).toBe("2026-01-01T11:55:00Z");
    advance(60 * MINUTE);
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).not.toBe(first);
  });

  it("adds a download disposition with the stored or given name", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload({ fileName: "café.png" });
    const stored = await t.action((ctx) =>
      azure.getUrl(ctx, fileId, { download: true }),
    );
    expect(params(stored).get("rscd")).toBe(
      `attachment; filename="caf_.png"; filename*=UTF-8''caf%C3%A9.png`,
    );
    const named = await t.action((ctx) =>
      azure.getUrl(ctx, fileId, { download: "a.png" }),
    );
    expect(params(named).get("rscd")).toContain(`filename="a.png"`);
  });

  it("overrides Cache-Control when asked", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    const url = await t.action((ctx) =>
      azure.getUrl(ctx, fileId, { cacheControl: "public, max-age=600" }),
    );
    expect(params(url).get("rscc")).toBe("public, max-age=600");
  });

  it("serves the public base URL without a token, but signs downloads", async () => {
    const { t, azure, upload } = setup({
      config: { ...config, publicBaseUrl: "https://cdn.example/up/" },
      pathPrefix: "img",
    });
    const fileId = await upload();
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toMatch(
      /^https:\/\/cdn\.example\/up\/img\/[0-9a-f-]{36}\.png$/,
    );
    const download = await t.action((ctx) =>
      azure.getUrl(ctx, fileId, { download: true }),
    );
    expect(download).toMatch(/^http:\/\/127\.0\.0\.1:10000\/.*rscd=/);
  });

  it("uses the container the file was uploaded to", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    const other = new AzureBlob(azure.component, {
      config: { ...config, container: "other" },
      now: () => T0,
    });
    expect(await t.action((ctx) => other.getUrl(ctx, fileId))).toContain(
      "/uploads/",
    );
  });

  it("returns null once the file is marked for deletion", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    expect(await t.action((ctx) => azure.markForDeletion(ctx, fileId))).toBe(
      true,
    );
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
    expect(await t.action((ctx) => azure.markForDeletion(ctx, "unknown"))).toBe(
      false,
    );
  });
});

describe("list and updateFile", () => {
  it("pages through ready files newest first, optionally per uploader", async () => {
    const { t, azure, upload, reserve, advance } = setup();
    const ids: string[] = [];
    for (const uploadedBy of ["u1", "u2", "u1", "u1"]) {
      ids.push(await upload({ uploadedBy }));
      advance(1000);
    }
    await reserve(); // pending: not listed
    const page = (cursor: string | null, uploadedBy?: string) =>
      t.action((ctx) =>
        azure.list(ctx, {
          uploadedBy,
          paginationOpts: { numItems: 2, cursor },
        }),
      );
    const first = await page(null);
    expect(first.page.map((f: FileDoc) => f.fileId)).toEqual([ids[3], ids[2]]);
    expect(first.isDone).toBe(false);
    const second = await page(first.continueCursor);
    expect(second.page.map((f: FileDoc) => f.fileId)).toEqual([ids[1], ids[0]]);
    const mine = await page(null, "u2");
    expect(mine.page.map((f: FileDoc) => f.fileId)).toEqual([ids[1]]);
    expect(mine.isDone).toBe(true);
  });

  it("replaces the file name and metadata, except while deleting", async () => {
    const { t, azure, upload, file } = setup();
    const fileId = await upload({ fileName: "a.png" });
    expect(
      await t.action((ctx) =>
        azure.updateFile(ctx, fileId, { metadata: { alt: "A cat" } }),
      ),
    ).toBe(true);
    expect(await file(fileId)).toMatchObject({
      fileName: "a.png",
      metadata: { alt: "A cat" },
    });
    await t.action((ctx) => azure.markForDeletion(ctx, fileId));
    expect(
      await t.action((ctx) =>
        azure.updateFile(ctx, fileId, { fileName: "b.png" }),
      ),
    ).toBe(false);
  });
});

describe("purge and sweep", () => {
  it("deletes the blob with a delete-only token, removing the row once the upload URL expired", async () => {
    const { t, azure, upload, file, advance } = setup();
    const fileId = await upload();
    advance(11 * MINUTE);
    stubBlob({});
    expect(await t.action((ctx) => azure.purge(ctx, fileId))).toBe(true);
    expect(methods()).toEqual(["DELETE"]);
    expect(params(String(fetchMock.mock.calls[0]?.[0])).get("sp")).toBe("d");
    expect(await file(fileId)).toBeNull();
    expect(await t.action((ctx) => azure.purge(ctx, fileId))).toBe(false);
  });

  it("keeps the row while the upload URL could still re-create the blob", async () => {
    const { t, azure, upload, file, advance } = setup();
    const fileId = await upload();
    stubBlob({});
    expect(await t.action((ctx) => azure.delete(ctx, fileId))).toBe(true);
    expect((await file(fileId))?.status).toBe("deleting");
    advance(11 * MINUTE);
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
    expect(methods()).toEqual(["DELETE", "DELETE"]);
    expect(await file(fileId)).toBeNull();
  });

  it("treats a missing blob as deleted and keeps the row when the delete fails", async () => {
    const { t, azure, upload, file, advance } = setup();
    const gone = await upload();
    const failing = await upload();
    advance(11 * MINUTE);
    stubBlob({}, 404);
    expect(await t.action((ctx) => azure.purge(ctx, gone))).toBe(true);
    expect(await file(gone)).toBeNull();
    stubBlob({}, 500);
    expect(await t.action((ctx) => azure.purge(ctx, failing))).toBe(false);
    expect((await file(failing))?.status).toBe("deleting");
  });

  it("sweeps stale pending uploads and files marked deleting, keeping fresh and ready ones", async () => {
    const { t, azure, reserve, upload, file, advance } = setup();
    const stale = await reserve();
    const ready = await upload();
    const marked = await upload();
    await t.action((ctx) => azure.markForDeletion(ctx, marked));
    advance(2 * 60 * MINUTE);
    const fresh = await reserve();
    stubBlob({});

    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(2);

    expect(await file(stale)).toBeNull();
    expect(await file(marked)).toBeNull();
    expect((await file(ready))?.status).toBe("ready");
    expect((await file(fresh))?.status).toBe("pending");
    expect(methods()).toEqual(["DELETE", "DELETE"]);
  });

  it("respects the sweep limit", async () => {
    const { t, azure, reserve, advance } = setup();
    for (let i = 0; i < 3; i++) await reserve();
    advance(2 * 60 * MINUTE);
    stubBlob({});
    expect(await t.action((ctx) => azure.sweep(ctx, { limit: 2 }))).toBe(2);
    expect(await t.action((ctx) => azure.sweep(ctx, { limit: 2 }))).toBe(1);
  });
});

describe("store", () => {
  it("PUTs the bytes as a block blob with a create-only token and confirms them", async () => {
    const { t, azure, file } = setup();
    stubBlob({ length: PNG.length });
    const result = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
        fileName: "x.png",
      }),
    );
    expect(result.ok).toBe(true);
    expect(methods()).toEqual(["PUT", "HEAD", "GET"]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(params(String(url)).get("sp")).toBe("c");
    expect(init?.headers).toMatchObject({ "x-ms-blob-type": "BlockBlob" });
    if (result.ok)
      expect(await file(result.fileId)).toMatchObject({
        status: "ready",
        fileName: "x.png",
      });
  });

  it("uses the internal endpoint for every server-side request", async () => {
    const { t, azure } = setup({
      config: {
        ...config,
        internalEndpoint: "http://azurite:10000/devstoreaccount1",
      },
    });
    stubBlob({ length: PNG.length });
    await t.action((ctx) =>
      azure.store(ctx, {
        data: new Blob([PNG]),
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/azurite:10000\//);
    }
  });

  it("reports a failed PUT and leaves nothing ready", async () => {
    const { t, azure } = setup();
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect(
      await t.action((ctx) =>
        azure.store(ctx, {
          data: PNG,
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    ).toEqual({ ok: false, reason: "Azure Blob upload failed with 403" });
  });

  it("refuses data over the size limit without uploading", async () => {
    const { t, azure } = setup({ maxBytes: 4 });
    await expect(
      t.action((ctx) =>
        azure.store(ctx, {
          data: PNG,
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    ).rejects.toThrow("too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("clientApi", () => {
  const onUpload = vi.fn();
  const app = defineTestApp({
    schema: defineSchema({}),
    components: { azureBlob: componentTest },
  });
  const azure = new AzureBlob(app.components.azureBlob, {
    config,
    now: () => T0,
  });
  const { api, createTest } = app.defineModules({
    files: azure.clientApi({
      identify: async (ctx) =>
        (await ctx.auth.getUserIdentity())?.subject ?? null,
      checkUpload: async (_ctx, args) => {
        if (args.fileName === "forbidden.png")
          throw new Error("Quota exceeded");
      },
      onUpload,
    }),
  });

  beforeEach(() => onUpload.mockReset());

  it("issues and confirms uploads for the signed-in user, calling onUpload once", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
      fileName: "cat.png",
    });
    expect(params(ticket.uploadUrl).get("sp")).toBe("c");
    stubBlob({});
    expect(
      await t.action(api.files.confirmUpload, { fileId: ticket.fileId }),
    ).toMatchObject({
      ok: true,
    });
    await t.action(api.files.confirmUpload, { fileId: ticket.fileId });
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload.mock.calls[0]?.[1]).toMatchObject({
      fileId: ticket.fileId,
      uploadedBy: "user1",
      fileName: "cat.png",
      status: "ready",
    });
  });

  it("refuses anonymous callers and checkUpload rejections", async () => {
    await expect(
      createTest().mutation(api.files.generateUploadUrl, {
        contentType: "image/png",
      }),
    ).rejects.toThrow("Not authorized");
    await expect(
      createTest()
        .withIdentity({ subject: "user1" })
        .mutation(api.files.generateUploadUrl, {
          contentType: "image/png",
          fileName: "forbidden.png",
        }),
    ).rejects.toThrow("Quota exceeded");
  });

  it("does not let one user confirm another user's upload", async () => {
    const t = createTest();
    const owner = t.withIdentity({ subject: "user1" });
    const { fileId } = await owner.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
    });
    stubBlob({});
    const intruder = t.withIdentity({ subject: "user2" });
    expect(await intruder.action(api.files.confirmUpload, { fileId })).toEqual({
      ok: false,
      reason: "Unknown upload",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
