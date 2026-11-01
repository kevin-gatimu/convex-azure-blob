/// <reference types="vite/client" />
import { convexTest, defineTestApp } from "convex-test";
import {
  defineSchema,
  defineTable,
  internalMutationGeneric,
} from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import componentTest, { register } from "../test.js";
import { AzureBlob } from "./index.js";
import type { AzureBlobOptions, FileDoc } from "./index.js";
import { effectiveUploadExpiry } from "./upload-expiry.js";
import {
  blockId,
  blockSizeFor,
  MAX_BLOCK_SIZE,
  MAX_BLOCKS,
  MIN_BLOCK_SIZE,
  parseBlockList,
} from "./blocks.js";

const config = {
  accountName: "devstoreaccount1",
  // Azurite's published development key, so not a secret.
  accountKey:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  container: "uploads",
  endpoint: "http://127.0.0.1:10000/devstoreaccount1",
};
const entraConfig = {
  accountName: "devstoreaccount1",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "client-secret",
  container: "uploads",
  endpoint: "https://devstoreaccount1.blob.core.windows.net",
};
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

function stubBlocks(
  options: {
    xml?: string;
    stagedSize?: number;
    snapshotSize?: number;
    snapshotStatus?: number;
    commitStatus?: number;
    bytes?: Uint8Array<ArrayBuffer>;
    listStatus?: number;
    type?: string;
  } = {},
) {
  fetchMock.mockImplementation(async (url, init) => {
    const params = new URL(String(url)).searchParams;
    if (params.get("comp") === "blocklist" && init?.method !== "PUT")
      return new Response(
        options.xml ??
          `<BlockList><CommittedBlocks/><UncommittedBlocks><Block><Name>${blockId(0)}</Name><Size>${options.stagedSize ?? PNG.length}</Size></Block></UncommittedBlocks></BlockList>`,
        { status: options.listStatus ?? 200 },
      );
    if (params.get("comp") === "blocklist")
      return new Response(null, {
        status: options.commitStatus ?? 201,
        headers: { etag: '"committed"' },
      });
    if (params.get("comp") === "snapshot")
      return new Response(null, {
        status: options.snapshotStatus ?? 201,
        headers: { "x-ms-snapshot": "2026-01-01T12:00:00.0000000Z" },
      });
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    if (init?.method === "HEAD") {
      if (!params.has("snapshot")) return new Response(null, { status: 404 });
      return new Response(null, {
        headers: {
          "content-length": String(options.snapshotSize ?? PNG.length),
          "content-type": options.type ?? "image/png",
        },
      });
    }
    return new Response(options.bytes ?? PNG, { status: 206 });
  });
}

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
  md5?: string;
  bytes?: Uint8Array<ArrayBuffer>;
};

function stubEntra(blob: Blob = {}, deleteStatus = 202) {
  stubBlob(blob, deleteStatus);
  const blobFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
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
    return await blobFetch(url, init);
  });
}

function setupEntra(blob: Blob = {}) {
  const state = setup({ config: entraConfig });
  stubEntra(blob);
  return state;
}

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
          ...(blob.md5 ? { "content-md5": blob.md5 } : {}),
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

function stubScanResult(result?: string, key = "Malware scanning scan result") {
  const blobFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === "GET" && parsed.searchParams.get("comp") === "tags") {
      const tags =
        result === undefined
          ? ""
          : `<Tag><Key>${key}</Key><Value>${result}</Value></Tag>`;
      return new Response(`<Tags><TagSet>${tags}</TagSet></Tags>`);
    }
    return await blobFetch(url, init);
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

  it("refuses malware gating with overwrite-capable block upload tickets", () => {
    expect(
      () =>
        new AzureBlob({} as never, {
          blockUploads: true,
          requireMalwareScan: true,
        }),
    ).toThrow("cannot be combined with blockUploads");
  });
});

describe("md5 integrity", () => {
  const md5 = "1B2M2Y8AsgTpgAmY7PhCfg==";
  const other = "AAAAAAAAAAAAAAAAAAAAAA==";
  const reserveWith = (
    state: ReturnType<typeof setup>,
    value: string | undefined,
  ) =>
    state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        ...(value === undefined ? {} : { md5: value }),
      }),
    );

  it("adds Content-MD5 to the ticket and stores the digest on the row", async () => {
    const state = setup();
    const ticket = await reserveWith(state, md5);
    expect(ticket.headers).toEqual({
      "x-ms-blob-type": "BlockBlob",
      "content-type": "image/png",
      "Content-MD5": md5,
    });
    expect((await state.file(ticket.fileId))?.md5).toBe(md5);
  });

  it("keeps Content-MD5 on a renewed ticket", async () => {
    const state = setup();
    const { fileId } = await reserveWith(state, md5);
    state.advance(MINUTE);
    const renewed = await state.t.action((ctx) =>
      state.azure.renewUploadUrl(ctx, { fileId, uploadedBy: "u1" }),
    );
    expect(renewed.headers["Content-MD5"]).toBe(md5);
  });

  it("rejects an md5 that is not base64 of 16 bytes", async () => {
    const state = setup();
    for (const bad of [
      "",
      "abc",
      "AAAAAAAAAAAAAAAAAAAAAA",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "AAAAAAAAAAAAAAAAAAAAAB==",
      "AAAAAAAAAAAAAAAAAAAA!A==",
      "d41d8cd98f00b204e9800998ecf8427e",
    ]) {
      await expect(reserveWith(state, bad)).rejects.toThrow("md5");
    }
  });

  it("accepts a matching Content-MD5 at confirm", async () => {
    const state = setup();
    const { fileId } = await reserveWith(state, md5);
    stubBlob({ md5 });
    const result = await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, fileId),
    );
    expect(result.ok).toBe(true);
    expect((await state.file(fileId))?.status).toBe("ready");
  });

  it("rejects and deletes the blob on a checksum mismatch", async () => {
    const state = setup();
    const { fileId } = await reserveWith(state, md5);
    stubBlob({ md5: other });
    const result = await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, fileId),
    );
    expect(result).toEqual({ ok: false, reason: "Checksum mismatch" });
    expect(methods()).toContain("DELETE");
    expect((await state.file(fileId))?.status).not.toBe("ready");
  });

  it("rejects and deletes the blob when Content-MD5 is missing", async () => {
    const state = setup();
    const { fileId } = await reserveWith(state, md5);
    stubBlob({});
    const result = await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, fileId),
    );
    expect(result).toEqual({ ok: false, reason: "Checksum mismatch" });
    expect(methods()).toContain("DELETE");
  });

  it("keeps today's behavior without an md5", async () => {
    const state = setup();
    const ticket = await reserveWith(state, undefined);
    expect(ticket.headers).not.toHaveProperty("Content-MD5");
    expect((await state.file(ticket.fileId))?.md5).toBeUndefined();
    stubBlob({});
    const result = await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, ticket.fileId),
    );
    expect(result.ok).toBe(true);
  });

  it("throws for md5 with block uploads", async () => {
    const state = setup({ blockUploads: true });
    await expect(
      state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          size: 1000,
          md5,
        }),
      ),
    ).rejects.toThrow("md5 is not supported with block uploads");
  });
});

describe("read", () => {
  const readText = (
    state: ReturnType<typeof setup>,
    fileId: string,
    options?: { range?: { start: number; end?: number } },
  ) =>
    state.t.action(async (ctx) => {
      const response = await state.azure.read(ctx, fileId, options);
      return response
        ? {
            status: response.status,
            bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
          }
        : null;
    });

  it("returns the bytes of a ready file with a read-only SAS", async () => {
    const state = setup();
    const fileId = await state.upload();
    fetchMock.mockImplementation(
      async () => new Response(PNG, { status: 200 }),
    );
    expect(await readText(state, fileId)).toEqual({
      status: 200,
      bytes: Array.from(PNG),
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(params(String(url)).get("sp")).toBe("r");
    expect(init?.method).toBe("GET");
    expect(init?.headers).not.toHaveProperty("x-ms-range");
  });

  it("returns null for a file that is not ready without calling Azure", async () => {
    const state = setup();
    const pending = await state.reserve();
    const deleting = await state.upload();
    await state.t.action((ctx) => state.azure.markForDeletion(ctx, deleting));
    fetchMock.mockClear();
    expect(await readText(state, pending)).toBeNull();
    expect(await readText(state, deleting)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for an unknown file id without calling Azure", async () => {
    const state = setup();
    fetchMock.mockClear();
    expect(await readText(state, "unknown")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a Response that does not expose the signed URL", async () => {
    const state = setup();
    const fileId = await state.upload();
    fetchMock.mockImplementation(async (url) => {
      const response = new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    });
    const seen = await state.t.action(async (ctx) => {
      const response = (await state.azure.read(ctx, fileId))!;
      return {
        url: response.url,
        type: response.headers.get("content-type"),
        size: (await response.arrayBuffer()).byteLength,
      };
    });
    expect(seen).toEqual({ url: "", type: "image/png", size: PNG.length });
  });

  it("throws when a range request is answered with the full file", async () => {
    const state = setup();
    const fileId = await state.upload();
    fetchMock.mockImplementation(
      async () => new Response(PNG, { status: 200 }),
    );
    await expect(
      readText(state, fileId, { range: { start: 2, end: 4 } }),
    ).rejects.toThrow("Azure Blob read failed with 200");
  });

  it("sends an inclusive x-ms-range and returns the 206 response", async () => {
    const state = setup();
    const fileId = await state.upload();
    fetchMock.mockImplementation(
      async () => new Response(PNG.slice(2, 5), { status: 206 }),
    );
    expect(
      await readText(state, fileId, { range: { start: 2, end: 4 } }),
    ).toEqual({ status: 206, bytes: Array.from(PNG.slice(2, 5)) });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-ms-range": "bytes=2-4",
    });
    await readText(state, fileId, { range: { start: 7 } });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-ms-range": "bytes=7-",
    });
  });

  it("rejects an invalid range before calling Azure", async () => {
    const state = setup();
    const fileId = await state.upload();
    for (const range of [
      { start: -1 },
      { start: 1.5 },
      { start: Number.NaN },
      { start: 5, end: 4 },
      { start: 0, end: 2.5 },
    ]) {
      await expect(readText(state, fileId, { range })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx response with the status but not the URL or SAS", async () => {
    const state = setup();
    const fileId = await state.upload();
    const body = new Response("denied", { status: 403 });
    const cancel = vi.spyOn(body.body!, "cancel");
    fetchMock.mockImplementation(async () => body);
    const error = await readText(state, fileId).catch((e: unknown) => e);
    const message = String((error as Error).message);
    expect(message).toContain("403");
    expect(message).not.toContain("http");
    expect(message).not.toContain("sig=");
    expect(message).not.toContain("devstoreaccount1");
    expect(cancel).toHaveBeenCalled();
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
  it.each(["mark", "purge"] as const)(
    "does not report success when %s wins during validation",
    async (operation) => {
      const { t, azure, reserve, file, advance } = setup();
      const fileId = await reserve();
      advance(11 * MINUTE);
      stubBlob({});
      const fetchBlob = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        const response = await fetchBlob(url, init);
        if (init?.method === "HEAD") {
          await t.action((ctx) =>
            operation === "purge"
              ? azure.purge(ctx, fileId)
              : azure.markForDeletion(ctx, fileId),
          );
        }
        return response;
      });
      expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual(
        {
          ok: false,
          reason: "Unknown upload",
        },
      );
      expect((await file(fileId))?.status ?? null).toBe(
        operation === "purge" ? null : "deleting",
      );
    },
  );

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

describe("malware scan gate", () => {
  it("keeps a confirmed file unservable until the scan result is clean", async () => {
    const { t, azure, reserve, file } = setup({ requireMalwareScan: true });
    const fileId = await reserve();
    stubBlob({});
    expect(await t.action((ctx) => azure.confirmUpload(ctx, fileId))).toEqual({
      ok: true,
      size: 1000,
      contentType: "image/png",
    });
    expect((await file(fileId))?.status).toBe("scanning");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();

    stubScanResult("No threats found", "Scan result");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    const [tagUrl, tagRequest] = fetchMock.mock.calls.at(-1)!;
    expect(new URL(String(tagUrl)).searchParams.get("comp")).toBe("tags");
    expect(new URL(String(tagUrl)).searchParams.get("sp")).toBe("t");
    expect(tagRequest?.method).toBe("GET");
    expect((await file(fileId))?.status).toBe("ready");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toContain(
      "sp=r",
    );
  });

  it("keeps a concurrent confirmation successful if scanning finishes first", async () => {
    const { t, azure, reserve, file } = setup({ requireMalwareScan: true });
    const fileId = await reserve();
    stubBlob({});
    const blobFetch = fetchMock.getMockImplementation()!;
    const firstHeadStarted = deferred();
    const secondHeadStarted = deferred();
    const releaseFirstHead = deferred();
    const releaseSecondHead = deferred();
    let heads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "HEAD") {
        if (++heads === 1) {
          firstHeadStarted.resolve();
          await releaseFirstHead.promise;
        } else {
          secondHeadStarted.resolve();
          await releaseSecondHead.promise;
        }
      }
      return await blobFetch(url, init);
    });

    const firstConfirmation = t.action((ctx) =>
      azure.confirmUpload(ctx, fileId),
    );
    await firstHeadStarted.promise;
    const secondConfirmation = t.action((ctx) =>
      azure.confirmUpload(ctx, fileId),
    );
    await secondHeadStarted.promise;
    releaseFirstHead.resolve();
    expect(await firstConfirmation).toMatchObject({ ok: true });

    stubScanResult("No threats found");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(fileId))?.status).toBe("ready");
    releaseSecondHead.resolve();
    expect(await secondConfirmation).toMatchObject({
      ok: true,
      size: 1000,
    });
  });

  it("deletes a malicious blob but retains an unservable rejected row", async () => {
    const { t, azure, reserve, file } = setup({ requireMalwareScan: true });
    const fileId = await reserve();
    stubBlob({});
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    stubScanResult("Malicious");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect(methods().slice(-2)).toEqual(["GET", "DELETE"]);
    expect((await file(fileId))?.status).toBe("rejected");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, fileId)),
    ).toMatchObject({
      ok: false,
      reason: "Malware scan detected a threat",
    });
  });

  it("keeps retrying malicious-blob deletion after the scan deadline", async () => {
    const { t, azure, reserve, file, advance } = setup({
      requireMalwareScan: true,
    });
    const fileId = await reserve();
    stubBlob({}, 500);
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    stubScanResult("Malicious");
    await expect(t.action((ctx) => azure.scanMalware(ctx))).rejects.toThrow(
      "Failed to process",
    );
    expect((await file(fileId))?.status).toBe("rejected");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();

    stubBlob({});
    advance(DAY);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(fileId))?.status).toBe("rejected");
    expect(methods().at(-1)).toBe("DELETE");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(0);
  });

  it("deletes a recreated malicious blob after the upload SAS expires", async () => {
    const { t, azure, file, advance } = setup({ requireMalwareScan: true });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    stubBlob({});
    await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId));
    stubScanResult("Malicious");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(ticket.fileId))?.status).toBe("rejected");

    expect(
      (
        await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: ticket.headers,
          body: PNG,
        })
      ).status,
    ).toBe(201);
    stubBlob({});
    advance(10 * MINUTE);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect(methods().at(-1)).toBe("DELETE");
    expect((await file(ticket.fileId))?.status).toBe("rejected");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(0);
  });

  it("defers a failed job and continues processing the rest of the batch", async () => {
    const { t, azure, reserve, file, advance } = setup({
      requireMalwareScan: true,
    });
    const first = await reserve();
    const second = await reserve();
    stubBlob({});
    await t.action((ctx) => azure.confirmUpload(ctx, first));
    await t.action((ctx) => azure.confirmUpload(ctx, second));

    const blobFetch = fetchMock.getMockImplementation()!;
    let tagReads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (
        init?.method === "GET" &&
        parsed.searchParams.get("comp") === "tags"
      ) {
        if (++tagReads === 1) return new Response(null, { status: 503 });
        return new Response(
          "<Tags><TagSet><Tag><Key>Scan result</Key><Value>No threats found</Value></Tag></TagSet></Tags>",
        );
      }
      return await blobFetch(url, init);
    });

    await expect(t.action((ctx) => azure.scanMalware(ctx))).rejects.toThrow(
      "Failed to process",
    );
    expect((await file(first))?.status).toBe("scanning");
    expect((await file(second))?.status).toBe("ready");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(0);
    advance(15_000);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(first))?.status).toBe("ready");
  });

  it("continues the batch after a malicious-blob deletion fails", async () => {
    const { t, azure, reserve, file, advance } = setup({
      requireMalwareScan: true,
    });
    const first = await reserve();
    const second = await reserve();
    stubBlob({}, 500);
    await t.action((ctx) => azure.confirmUpload(ctx, first));
    await t.action((ctx) => azure.confirmUpload(ctx, second));

    const blobFetch = fetchMock.getMockImplementation()!;
    let tagReads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (
        init?.method === "GET" &&
        parsed.searchParams.get("comp") === "tags"
      ) {
        const result = ++tagReads === 1 ? "Malicious" : "No threats found";
        return new Response(
          `<Tags><TagSet><Tag><Key>Scan result</Key><Value>${result}</Value></Tag></TagSet></Tags>`,
        );
      }
      return await blobFetch(url, init);
    });

    await expect(t.action((ctx) => azure.scanMalware(ctx))).rejects.toThrow(
      "Failed to process",
    );
    expect((await file(first))?.status).toBe("rejected");
    expect((await file(second))?.status).toBe("ready");

    stubBlob({});
    advance(15_000);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(first))?.status).toBe("rejected");
  });

  it("times out unresolved scan results after 24 hours", async () => {
    const { t, azure, reserve, file, advance } = setup({
      requireMalwareScan: true,
    });
    const fileId = await reserve();
    stubBlob({});
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    stubScanResult();
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(fileId))?.status).toBe("scanning");

    advance(15_000);
    stubScanResult("Error");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(fileId))?.status).toBe("scanning");
    advance(DAY);
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect((await file(fileId))?.status).toBe("scan_timed_out");
    expect(await t.action((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
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
  it("supports legacy file rows without a stored upload expiry", async () => {
    const componentDb = convexTest(componentTest.schema, componentTest.modules);
    const createdAt = T0 - 2 * DAY;
    const fileId = await componentDb.run((ctx) =>
      ctx.db.insert("files", {
        container: "uploads",
        blobName: "photos/legacy.png",
        contentType: "image/png",
        maxBytes: 5 * 1024 * 1024,
        uploadedBy: "u1",
        status: "deleting",
        createdAt,
      }),
    );

    const legacyRow = await componentDb.run((ctx) =>
      ctx.db.get("files", fileId),
    );
    expect(legacyRow).toMatchObject({
      _id: fileId,
      status: "deleting",
      createdAt,
    });
    expect(legacyRow).not.toHaveProperty("uploadExpiresAt");
    expect(effectiveUploadExpiry({ createdAt }, 5 * MINUTE)).toBe(
      createdAt + 60 * MINUTE,
    );
    expect(
      effectiveUploadExpiry(
        { createdAt, uploadExpiresAt: createdAt + 24 * 60 * MINUTE },
        5 * MINUTE,
      ),
    ).toBe(createdAt + 24 * 60 * MINUTE);
  });

  it("uses the issued expiry when another client has a shorter upload lifetime", async () => {
    const { t, azure, reserve, file, advance } = setup({
      uploadTtlSeconds: 24 * 60 * 60,
    });
    const fileId = await reserve();
    expect((await file(fileId))?.uploadExpiresAt).toBe(T0 + 24 * 60 * MINUTE);
    const cleanup = new AzureBlob(azure.component, {
      config,
      now: () => T0 + 60 * MINUTE,
    });
    stubBlob({});
    expect(await t.action((ctx) => cleanup.purge(ctx, fileId))).toBe(true);
    expect((await file(fileId))?.status).toBe("deleting");
    advance(24 * 60 * MINUTE + 5 * MINUTE);
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
    expect(await file(fileId)).toBeNull();
  });

  it("claims a stale upload before deleting its blob, refusing an in-flight confirmation", async () => {
    const { t, azure, reserve, file, advance } = setup();
    const fileId = await reserve();
    advance(2 * 60 * MINUTE);
    const checking = deferred();
    const resume = deferred();
    stubBlob({});
    const fetchBlob = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "HEAD") {
        checking.resolve();
        await resume.promise;
      }
      if (init?.method === "DELETE") {
        expect((await file(fileId))?.status).toBe("deleting");
      }
      return await fetchBlob(url, init);
    });
    const confirming = t.action((ctx) => azure.confirmUpload(ctx, fileId));
    await checking.promise;
    try {
      expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
    } finally {
      resume.resolve();
    }
    expect(await confirming).toEqual({ ok: false, reason: "Unknown upload" });
    expect(await file(fileId)).toBeNull();
  });

  it("preserves an old upload confirmed before sweep claims it", async () => {
    const { t, azure, reserve, file, advance } = setup();
    const fileId = await reserve();
    advance(2 * 60 * MINUTE);
    stubBlob({});
    expect((await t.action((ctx) => azure.confirmUpload(ctx, fileId))).ok).toBe(
      true,
    );
    fetchMock.mockClear();
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(0);
    expect((await file(fileId))?.status).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it("sweeps an eligible old upload that sorts behind young short-lived ones", async () => {
    const state = setup({
      blockUploads: true,
      uploadTtlSeconds: 2 * 60 * 60,
    });
    const old = (
      await state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          size: PNG.length,
        }),
      )
    ).fileId;
    const shortLived = new AzureBlob(state.azure.component, {
      config,
      now: () => T0 + 10 * MINUTE,
      blockUploads: true,
      uploadTtlSeconds: 60,
    });
    const young: string[] = [];
    for (let i = 0; i < 2; i++) {
      const ticket = await state.t.action((ctx) =>
        shortLived.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          size: PNG.length,
        }),
      );
      young.push(ticket.fileId);
    }
    state.advance(3 * 60 * MINUTE);
    stubBlob({});
    expect(
      await state.t.action((ctx) =>
        state.azure.sweep(ctx, { limit: 1, pendingOlderThanMs: 175 * MINUTE }),
      ),
    ).toBe(1);
    expect(await state.file(old)).toBeNull();
    for (const id of young)
      expect((await state.file(id))?.status).toBe("pending");
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
        uploadExpiresAt: Date.parse(params(String(url)).get("se")!),
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

describe("storeFromUrl", () => {
  it("copies an HTTPS source as a block blob and confirms it", async () => {
    const maxBytes = 6000 * 1024 * 1024;
    const state = setup({ maxBytes });
    stubBlob({ length: PNG.length });
    const blobFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      return await blobFetch(url, init);
    });
    const sourceUrl = "https://source.example/image.png?sig=fake";
    const result = await state.t.action((ctx) =>
      state.azure.storeFromUrl(ctx, {
        sourceUrl,
        contentType: "IMAGE/PNG; charset=binary",
        uploadedBy: "u1",
        maxBytes,
        fileName: "import.png",
      }),
    );

    expect(result.ok).toBe(true);
    expect(methods()).toEqual(["PUT", "HEAD", "GET"]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(params(String(url)).get("sp")).toBe("c");
    expect(init?.headers).toMatchObject({
      "content-length": "0",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-blob-content-type": "image/png",
      "x-ms-copy-source": sourceUrl,
    });
    if (result.ok)
      expect(await state.file(result.fileId)).toMatchObject({
        status: "ready",
        fileName: "import.png",
        maxBytes: 5000 * 1024 * 1024,
      });
  });

  it.each([
    ["not a URL", "Source URL must be a valid HTTPS URL"],
    ["http://source.example/image.png", "Source URL must be HTTPS"],
    ["https://source.example/image.png#fragment", "cannot include credentials"],
    [
      `https://source.example/${"a".repeat(2048)}`,
      "Source URL must be no longer than 2 KiB",
    ],
  ])(
    "rejects unsafe source URL %s before Azure requests",
    async (sourceUrl) => {
      const { t, azure } = setup();
      expect(
        await t.action((ctx) =>
          azure.storeFromUrl(ctx, {
            sourceUrl,
            contentType: "image/png",
            uploadedBy: "u1",
          }),
        ),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("Source URL"),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reports the 409 source limit and attempts cleanup", async () => {
    const state = setup();
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 202 })
        : new Response(null, { status: 409 }),
    );
    const result = await state.t.action((ctx) =>
      state.azure.storeFromUrl(ctx, {
        sourceUrl: "https://source.example/large.bin",
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Azure Blob URL copy failed with 409; the source must have a valid Content-Length and be no larger than 5,000 MiB",
    });
    expect(methods()).toEqual(["PUT", "DELETE"]);
  });

  it("cleans up an Azure copy failure without exposing the source URL", async () => {
    const state = setup();
    const sourceUrl = "https://source.example/file.png?sig=private";
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 202 })
        : new Response(null, { status: 403 }),
    );
    const result = await state.t.action((ctx) =>
      state.azure.storeFromUrl(ctx, {
        sourceUrl,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "Azure Blob URL copy failed with 403",
    });
    expect(methods()).toEqual(["PUT", "DELETE"]);
    expect(JSON.stringify(result)).not.toContain(sourceUrl);
  });

  it("cleans up when the Azure copy request rejects", async () => {
    const state = setup();
    const sourceUrl = "https://source.example/file.png?sig=private";
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "PUT") throw new Error(`unreachable ${sourceUrl}`);
      return new Response(null, { status: 202 });
    });

    const result = await state.t.action((ctx) =>
      state.azure.storeFromUrl(ctx, {
        sourceUrl,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "Azure Blob URL copy request failed",
    });
    expect(methods()).toEqual(["PUT", "DELETE"]);
    expect(JSON.stringify(result)).not.toContain(sourceUrl);
  });

  it("deletes a copied blob rejected by the normal signature check", async () => {
    const state = setup();
    stubBlob({ length: PNG.length, bytes: new Uint8Array([1, 2, 3]) });
    const blobFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      return await blobFetch(url, init);
    });

    expect(
      await state.t.action((ctx) =>
        state.azure.storeFromUrl(ctx, {
          sourceUrl: "https://source.example/not-a-png",
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "The file content does not match its type",
    });
    expect(methods()).toEqual(["PUT", "HEAD", "GET", "DELETE"]);
  });
});

describe("Microsoft Entra user-delegation SAS", () => {
  it("refreshes only when the cached key has less than two days remaining", async () => {
    const { t, azure, advance } = setupEntra();
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/oauth2/v2.0/token",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "comp=userdelegationkey",
    );

    fetchMock.mockClear();
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    expect(fetchMock).not.toHaveBeenCalled();

    advance(6 * DAY);
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("force-replaces a still-valid key, and a failed forced refresh keeps the cached one", async () => {
    const { t, azure } = setupEntra();
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const cachedKey = () =>
      t.query(azure.component.lib.getUserDelegationKey, {
        accountName: entraConfig.accountName,
        now: T0,
      });
    const first = await cachedKey();
    fetchMock.mockClear();
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx, {}));
    expect(fetchMock).not.toHaveBeenCalled();

    const entra = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("comp=userdelegationkey"))
        return new Response(
          "<UserDelegationKey><SignedOid>99999999-2222-3333-4444-555555555555</SignedOid><SignedTid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</SignedTid><SignedStart>2026-01-01T11:55:00Z</SignedStart><SignedExpiry>2026-01-08T11:55:00Z</SignedExpiry><SignedService>b</SignedService><SignedVersion>2022-11-02</SignedVersion><Value>cmVwbGFjZW1lbnQ=</Value></UserDelegationKey>",
        );
      return await entra(url, init);
    });
    await t.action((ctx) =>
      azure.refreshUserDelegationKey(ctx, { force: true }),
    );
    const replaced = await cachedKey();
    expect(replaced?.signedObjectId).toBe(
      "99999999-2222-3333-4444-555555555555",
    );
    expect(replaced?.keyValue).not.toBe(first?.keyValue);

    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("comp=userdelegationkey"))
        return new Response("denied", { status: 403 });
      return await entra(url, init);
    });
    await expect(
      t.action((ctx) => azure.refreshUserDelegationKey(ctx, { force: true })),
    ).rejects.toThrow("failed with 403");
    expect((await cachedKey())?.keyValue).toBe(replaced?.keyValue);
  });

  it("does nothing for shared-key accounts even when forced", async () => {
    const { t, azure } = setup();
    await t.action((ctx) =>
      azure.refreshUserDelegationKey(ctx, { force: true }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs browser URLs from the cache and uses OAuth for server requests", async () => {
    const { t, azure, advance } = setupEntra({ length: PNG.length });
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    fetchMock.mockClear();

    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    const uploadParams = params(ticket.uploadUrl);
    expect(uploadParams.get("skoid")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(uploadParams.get("sktid")).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(uploadParams.get("sp")).toBe("c");
    expect(fetchMock).not.toHaveBeenCalled();

    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true, size: PNG.length });
    const confirmCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("/oauth2/v2.0/token"),
    );
    expect(confirmCalls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "HEAD",
      "GET",
    ]);
    for (const [url, init] of confirmCalls) {
      expect(params(String(url)).has("sig")).toBe(false);
      expect(init?.headers).toMatchObject({
        authorization: "Bearer access-token",
        "x-ms-version": "2022-11-02",
      });
    }

    fetchMock.mockClear();
    const readUrl = await t.action((ctx) => azure.getUrl(ctx, ticket.fileId));
    expect(params(readUrl).get("skoid")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockClear();
    expect(await t.action((ctx) => azure.delete(ctx, ticket.fileId))).toBe(
      true,
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1]
        ?.headers,
    ).toMatchObject({ authorization: "Bearer access-token" });
    expect(
      fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1]
        ?.headers,
    ).toMatchObject({ "x-ms-version": "2022-11-02" });

    advance(11 * MINUTE);
    fetchMock.mockClear();
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);

    fetchMock.mockClear();
    const stored = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(stored.ok).toBe(true);
    const storeCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("/oauth2/v2.0/token"),
    );
    expect(storeCalls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "PUT",
      "HEAD",
      "GET",
    ]);
    for (const [url, init] of storeCalls) {
      expect(params(String(url)).has("sig")).toBe(false);
      expect(init?.headers).toMatchObject({
        authorization: "Bearer access-token",
        "x-ms-version": "2022-11-02",
      });
    }

    fetchMock.mockClear();
    const storedFromUrl = await t.action((ctx) =>
      azure.storeFromUrl(ctx, {
        sourceUrl: "https://source.example/image.png",
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(storedFromUrl.ok).toBe(true);
    const copyCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("/oauth2/v2.0/token"),
    );
    expect(copyCalls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "PUT",
      "HEAD",
      "GET",
    ]);
    for (const [url, init] of copyCalls) {
      expect(params(String(url)).has("sig")).toBe(false);
      expect(init?.headers).toMatchObject({
        authorization: expect.stringMatching(/^Bearer /),
        "x-ms-version": "2022-11-02",
      });
    }
  });

  it("fails clearly when a cached delegation key is absent or expired", async () => {
    const { t, azure } = setupEntra({ length: PNG.length });
    await expect(
      t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    ).rejects.toThrow("No valid Azure user delegation key is cached");
    expect(fetchMock).not.toHaveBeenCalled();

    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId));
    await t.mutation(azure.component.lib.upsertUserDelegationKey, {
      accountName: entraConfig.accountName,
      keyValue: "dGVzdC1kZWxlZ2F0aW9uLWtleQ==",
      signedObjectId: "11111111-2222-3333-4444-555555555555",
      signedTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      signedStart: "2026-01-01T11:55:00Z",
      signedExpiry: "2026-01-01T12:00:00Z",
      signedService: "b",
      signedVersion: "2022-11-02",
    });
    fetchMock.mockClear();
    await expect(
      t.action((ctx) => azure.getUrl(ctx, ticket.fileId)),
    ).rejects.toThrow("No valid Azure user delegation key is cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("block uploads", () => {
  const reserveBlock = async (
    state: ReturnType<typeof setup>,
    size = PNG.length,
  ) =>
    await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        uploadedBy: "u1",
        contentType: "image/png",
        size,
      }),
    );

  it("requires finite positive safe sizes and adapts up to Azure's maximum", async () => {
    const state = setup({
      blockUploads: true,
      maxBytes: MAX_BLOCK_SIZE * MAX_BLOCKS,
    });
    for (const size of [
      undefined,
      0,
      -1,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER,
    ]) {
      await expect(
        state.t.action((ctx) =>
          state.azure.generateUploadUrl(ctx, {
            uploadedBy: "u1",
            contentType: "image/png",
            size,
          }),
        ),
      ).rejects.toThrow("Invalid block upload size");
    }
    expect(blockSizeFor(MIN_BLOCK_SIZE * MAX_BLOCKS + 1)).toBe(
      MIN_BLOCK_SIZE + 1,
    );
    for (const uploadTtlSeconds of [0, Infinity, 604801])
      expect(() => setup({ blockUploads: true, uploadTtlSeconds })).toThrow(
        "Block upload TTL",
      );
    const ticket = await reserveBlock(state, MAX_BLOCK_SIZE * MAX_BLOCKS);
    expect(ticket).toMatchObject({
      kind: "blocks",
      blockSize: MAX_BLOCK_SIZE,
      expiresAt: T0 + 5 * MINUTE,
    });
    expect(new URL(ticket.uploadUrl).searchParams.get("sp")).toBe("w");
    expect(new URL(ticket.uploadUrl).searchParams.get("sr")).toBe("b");
    expect(await state.file(ticket.fileId)).toMatchObject({
      expectedSize: MAX_BLOCK_SIZE * MAX_BLOCKS,
      uploadMode: "blocks",
    });
    await expect(
      reserveBlock(setup({ blockUploads: true }), 11 * 1024 * 1024),
    ).rejects.toThrow("too large");
  });

  it("strictly rejects malformed, duplicate, unsafe and foreign block records before commit", async () => {
    for (const xml of [
      "<bad/>",
      "<BlockList><UncommittedBlocks><Block><Name>bad</Name><Size>12</Size></Block></UncommittedBlocks></BlockList>",
      `<BlockList><UncommittedBlocks>${`<Block><Name>${blockId(0)}</Name><Size>12</Size></Block>`.repeat(2)}</UncommittedBlocks></BlockList>`,
      `<BlockList><UncommittedBlocks><Block><Name>${blockId(0)}</Name><Size>9007199254740993</Size></Block></UncommittedBlocks></BlockList>`,
      `<BlockList><UncommittedBlocks><Block><Name>${blockId(0)}</Name><Size>13</Size></Block></UncommittedBlocks></BlockList>`,
      "<!DOCTYPE x><BlockList/>",
    ]) {
      const state = setup({ blockUploads: true });
      const ticket = await reserveBlock(state);
      stubBlocks({ xml });
      expect(
        (
          await state.t.action((ctx) =>
            state.azure.confirmUpload(ctx, ticket.fileId),
          )
        ).ok,
      ).toBe(false);
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
      ).toBe(false);
      fetchMock.mockClear();
    }
    expect(() =>
      parseBlockList(
        "<BlockList><UncommittedBlocks><Block><Name>a</Name><Size>0</Size></Block></UncommittedBlocks></BlockList>",
      ),
    ).toThrow();
  });

  it("rejects missing, expired and oversize staged uploads without committing", async () => {
    const state = setup({ blockUploads: true });
    const ticket = await reserveBlock(state);
    stubBlocks({ listStatus: 404 });
    expect(
      await state.t.action((ctx) =>
        state.azure.confirmUpload(ctx, ticket.fileId),
      ),
    ).toEqual({ ok: false, reason: "Upload not found" });
    stubBlocks({ stagedSize: MIN_BLOCK_SIZE + 1 });
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
    state.advance(6 * MINUTE);
    fetchMock.mockClear();
    expect(
      await state.t.action((ctx) =>
        state.azure.confirmUpload(ctx, ticket.fileId),
      ),
    ).toEqual({ ok: false, reason: "Upload expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conditionally commits and snapshots, validates only the snapshot, and confirms idempotently", async () => {
    const state = setup({ blockUploads: true });
    const ticket = await reserveBlock(state);
    stubBlocks();
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(true);
    const puts = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(puts).toHaveLength(2);
    expect(puts[0]?.[1]?.headers).toMatchObject({ "If-None-Match": "*" });
    expect(String(puts[0]?.[1]?.body)).toContain(
      `<Uncommitted>${blockId(0)}</Uncommitted>`,
    );
    expect(puts[1]?.[1]?.headers).toMatchObject({ "If-Match": '"committed"' });
    expect(await state.file(ticket.fileId)).toMatchObject({
      snapshot: "2026-01-01T12:00:00.0000000Z",
      status: "ready",
    });

    const url = await state.t.action((ctx) =>
      state.azure.getUrl(ctx, ticket.fileId),
    );
    expect(new URL(url!).searchParams.get("sr")).toBe("bs");
    fetchMock.mockClear();
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await state.t.action((ctx) => state.azure.purge(ctx, ticket.fileId));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-ms-delete-snapshots": "include",
    });
  });

  it("orders multiple fixed-width IDs and recovers a committed list after an interrupted snapshot", async () => {
    const state = setup({ blockUploads: true, maxBytes: 32 * 1024 * 1024 });
    const size = MIN_BLOCK_SIZE + PNG.length;
    const ticket = await reserveBlock(state, size);
    const xml = `<BlockList><CommittedBlocks><Block><Name>${blockId(1)}</Name><Size>${PNG.length}</Size></Block><Block><Name>${blockId(0)}</Name><Size>${MIN_BLOCK_SIZE}</Size></Block></CommittedBlocks><UncommittedBlocks/></BlockList>`;
    stubBlocks({ xml, snapshotSize: size });
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (
        init?.method === "HEAD" &&
        !new URL(String(url)).searchParams.has("snapshot")
      )
        return new Response(null, {
          headers: { etag: '"previous"', "content-length": String(size) },
        });
      return await original(url, init);
    });
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(true);
    const commit = fetchMock.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).searchParams.get("comp") === "blocklist" &&
        init?.method === "PUT",
    );
    expect(commit?.[1]?.headers).toMatchObject({ "If-Match": '"previous"' });
    expect(String(commit?.[1]?.body)).toContain(
      `<Committed>${blockId(0)}</Committed><Committed>${blockId(1)}</Committed>`,
    );
  });

  it.each([
    { snapshotStatus: 412 },
    { commitStatus: 412 },
    { snapshotSize: PNG.length + 1 },
    { type: "text/plain" },
    { bytes: new Uint8Array([1, 2, 3]) },
  ])("never marks racing or unverified content ready: %j", async (options) => {
    const state = setup({ blockUploads: true });
    const ticket = await reserveBlock(state);
    stubBlocks(options);
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(false);
    expect((await state.file(ticket.fileId))?.status).not.toBe("ready");
  });

  it("renews expired pending tickets with the same blob, guards ownership, and respects renewal in sweep", async () => {
    const state = setup({ blockUploads: true });
    const ticket = await reserveBlock(state);
    state.advance(2 * 60 * MINUTE);
    const renewed = await state.t.action((ctx) =>
      state.azure.renewUploadUrl(ctx, {
        fileId: ticket.fileId,
        uploadedBy: "u1",
      }),
    );
    expect(renewed.fileId).toBe(ticket.fileId);
    expect(new URL(renewed.uploadUrl).pathname).toBe(
      new URL(ticket.uploadUrl).pathname,
    );
    expect(renewed.expiresAt).toBe(T0 + 125 * MINUTE);
    await expect(
      state.t.action((ctx) =>
        state.azure.renewUploadUrl(ctx, {
          fileId: ticket.fileId,
          uploadedBy: "u2",
        }),
      ),
    ).rejects.toThrow("Unknown upload");
    expect(await state.t.action((ctx) => state.azure.sweep(ctx))).toBe(0);
    stubBlocks();
    await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, ticket.fileId),
    );
    await expect(
      state.t.action((ctx) =>
        state.azure.renewUploadUrl(ctx, {
          fileId: ticket.fileId,
          uploadedBy: "u1",
        }),
      ),
    ).rejects.toThrow("Unknown upload");
    await state.t.action((ctx) =>
      state.azure.markForDeletion(ctx, ticket.fileId),
    );
    await expect(
      state.t.action((ctx) =>
        state.azure.renewUploadUrl(ctx, {
          fileId: ticket.fileId,
          uploadedBy: "u1",
        }),
      ),
    ).rejects.toThrow("Unknown upload");
  });

  it("keeps cleanup tracking at the old expiry when a shorter renewal is issued", async () => {
    const state = setup({
      blockUploads: true,
      uploadTtlSeconds: 24 * 60 * 60,
    });
    const ticket = await reserveBlock(state);
    const renewer = new AzureBlob(state.azure.component, {
      config,
      now: () => T0 + MINUTE,
      blockUploads: true,
    });
    const renewed = await state.t.action((ctx) =>
      renewer.renewUploadUrl(ctx, { fileId: ticket.fileId, uploadedBy: "u1" }),
    );
    expect(renewed.expiresAt).toBe(T0 + 6 * MINUTE);
    expect((await state.file(ticket.fileId))?.uploadExpiresAt).toBe(
      T0 + 24 * 60 * MINUTE,
    );
    const direct = await state.t.mutation(
      state.azure.component.lib.renewUpload,
      {
        fileId: ticket.fileId,
        uploadedBy: "u1",
        now: T0 + 2 * MINUTE,
        expiresAt: T0 + 7 * MINUTE,
      },
    );
    expect(direct?.uploadExpiresAt).toBe(T0 + 24 * 60 * MINUTE);
    state.advance(2 * 60 * MINUTE);
    expect(await state.t.action((ctx) => state.azure.sweep(ctx))).toBe(0);
  });

  it("guards component ready transitions and retains the first snapshot", async () => {
    const state = setup({ blockUploads: true });
    const ticket = await reserveBlock(state);
    await expect(
      state.t.mutation((ctx) =>
        ctx.runMutation(state.azure.component.lib.markReady, {
          fileId: ticket.fileId,
          size: PNG.length,
        }),
      ),
    ).rejects.toThrow("Unverified");
    const first = "2026-01-01T12:00:00.0000000Z";
    expect(
      await state.t.mutation((ctx) =>
        ctx.runMutation(state.azure.component.lib.recordSnapshot, {
          fileId: ticket.fileId,
          snapshot: first,
        }),
      ),
    ).toBe(first);
    expect(
      await state.t.mutation((ctx) =>
        ctx.runMutation(state.azure.component.lib.recordSnapshot, {
          fileId: ticket.fileId,
          snapshot: "2026-01-01T12:01:00.0000000Z",
        }),
      ),
    ).toBe(first);
    await expect(
      state.t.mutation((ctx) =>
        ctx.runMutation(state.azure.component.lib.markReady, {
          fileId: ticket.fileId,
          size: PNG.length,
          snapshot: "other",
        }),
      ),
    ).rejects.toThrow("Unverified");
  });
});

describe("block clientApi", () => {
  const callback = vi.fn();
  const app = defineTestApp({
    schema: defineSchema({ attachments: defineTable({ fileId: v.string() }) }),
    components: { azureBlob: componentTest },
  });
  const azure = new AzureBlob(app.components.azureBlob, {
    config,
    blockUploads: true,
    now: () => T0,
  });
  const callbacks = {
    attach: internalMutationGeneric({
      args: { fileId: v.string() },
      returns: v.null(),
      handler: async (ctx, args) => {
        await ctx.db.insert("attachments", args);
        await callback();
        return null;
      },
    }),
  };
  const { internal } = app.defineModules({ callbacks });
  const { api, createTest } = app.defineModules({
    callbacks,
    files: azure.clientApi({
      identify: async (ctx) =>
        (await ctx.auth.getUserIdentity())?.subject ?? null,
      onUpload: internal.callbacks.attach,
    }),
  });
  beforeEach(() => callback.mockReset());

  it("authorizes renewal and confirmation before Azure work", async () => {
    const owner = createTest().withIdentity({ subject: "owner" });
    const ticket = await owner.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
      size: PNG.length,
    });
    const other = owner.withIdentity({ subject: "other" });
    await expect(
      other.mutation(api.files.renewUploadUrl, { fileId: ticket.fileId }),
    ).rejects.toThrow("Unknown upload");
    expect(
      await other.action(api.files.confirmUpload, { fileId: ticket.fileId }),
    ).toEqual({ ok: false, reason: "Unknown upload" });
    const anonymous = createTest();
    await expect(
      anonymous.mutation(api.files.renewUploadUrl, { fileId: ticket.fileId }),
    ).rejects.toThrow("Not authorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed callback using the recorded snapshot without another commit", async () => {
    const t = createTest().withIdentity({ subject: "owner" });
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
      size: PNG.length,
    });
    stubBlocks();
    callback.mockRejectedValueOnce(new Error("Attachment failed"));
    await expect(
      t.action(api.files.confirmUpload, { fileId: ticket.fileId }),
    ).rejects.toThrow("Attachment failed");
    expect(
      (await t.action((ctx) => azure.getFile(ctx, ticket.fileId)))?.snapshot,
    ).toBeTruthy();
    fetchMock.mockClear();
    expect(
      (await t.action(api.files.confirmUpload, { fileId: ticket.fileId })).ok,
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
    await t.action(api.files.confirmUpload, { fileId: ticket.fileId });
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("commits the callback only once for simultaneous snapshot confirmations", async () => {
    const t = createTest().withIdentity({ subject: "owner" });
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
      size: PNG.length,
    });
    stubBlocks();
    const results = await Promise.all([
      t.action(api.files.confirmUpload, { fileId: ticket.fileId }),
      t.action(api.files.confirmUpload, { fileId: ticket.fileId }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("clientApi", () => {
  const onUpload = vi.fn();
  let gatedNow = T0;
  const app = defineTestApp({
    schema: defineSchema({
      attachments: defineTable({ fileId: v.string(), uploadedBy: v.string() }),
    }),
    components: { azureBlob: componentTest },
  });
  const azure = new AzureBlob(app.components.azureBlob, {
    config,
    now: () => T0,
  });
  const callbacks = {
    attach: internalMutationGeneric({
      args: { fileId: v.string() },
      returns: v.null(),
      handler: async (ctx, { fileId }) => {
        const file = await azure.getFile(ctx, fileId);
        if (!file || file.status !== "ready") throw new Error("File not ready");
        await ctx.db.insert("attachments", {
          fileId,
          uploadedBy: file.uploadedBy,
        });
        await onUpload(ctx, file);
        return null;
      },
    }),
  };
  const { internal } = app.defineModules({ callbacks });
  const { api, createTest } = app.defineModules({
    callbacks,
    files: azure.clientApi({
      identify: async (ctx) =>
        (await ctx.auth.getUserIdentity())?.subject ?? null,
      checkUpload: async (_ctx, args) => {
        if (args.fileName === "forbidden.png")
          throw new Error("Quota exceeded");
      },
      onUpload: internal.callbacks.attach,
    }),
  });
  const gatedAzure = new AzureBlob(app.components.azureBlob, {
    config,
    now: () => gatedNow,
    requireMalwareScan: true,
  });
  const { api: gatedApi, createTest: createGatedTest } = app.defineModules({
    callbacks,
    gatedFiles: gatedAzure.clientApi({
      identify: async (ctx) =>
        (await ctx.auth.getUserIdentity())?.subject ?? null,
      onUpload: internal.callbacks.attach,
    }),
  });

  beforeEach(() => {
    onUpload.mockReset();
    gatedNow = T0;
  });

  it("accepts md5 through the public mutation and refuses a mismatched blob", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    const md5 = "1B2M2Y8AsgTpgAmY7PhCfg==";
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
      md5,
    });
    expect(ticket.headers["Content-MD5"]).toBe(md5);
    await expect(
      t.mutation(api.files.generateUploadUrl, {
        contentType: "image/png",
        md5: "not-a-digest",
      }),
    ).rejects.toThrow("md5");
    stubBlob({ md5: "AAAAAAAAAAAAAAAAAAAAAA==" });
    expect(
      await t.action(api.files.confirmUpload, { fileId: ticket.fileId }),
    ).toMatchObject({ ok: false });
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("commits one attachment for simultaneous confirmations", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    const { fileId } = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
    });
    const bothChecking = deferred();
    let heads = 0;
    stubBlob({});
    const fetchBlob = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "HEAD") {
        if (++heads === 2) bothChecking.resolve();
        await bothChecking.promise;
      }
      return await fetchBlob(url, init);
    });
    const results = await Promise.all([
      t.action(api.files.confirmUpload, { fileId }),
      t.action(api.files.confirmUpload, { fileId }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(heads).toBe(2);
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(1);
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed attachment and retries it on the next confirmation", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    const { fileId } = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
    });
    stubBlob({});
    onUpload.mockRejectedValueOnce(new Error("Attachment failed"));
    await expect(t.action(api.files.confirmUpload, { fileId })).rejects.toThrow(
      "Attachment failed",
    );
    expect(
      (await t.query(app.components.azureBlob.lib.get, { fileId }))?.status,
    ).toBe("pending");
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(0);
    expect((await t.action(api.files.confirmUpload, { fileId })).ok).toBe(true);
    await t.action(api.files.confirmUpload, { fileId });
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(1);
  });

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

  it("runs onUpload only after the malware scan reports clean", async () => {
    const t = createGatedTest().withIdentity({ subject: "user1" });
    const ticket = await t.mutation(gatedApi.gatedFiles.generateUploadUrl, {
      contentType: "image/png",
    });
    stubBlob({});
    expect(
      await t.action(gatedApi.gatedFiles.confirmUpload, {
        fileId: ticket.fileId,
      }),
    ).toMatchObject({ ok: true });
    expect(onUpload).not.toHaveBeenCalled();

    stubScanResult("No threats found");
    expect(await t.action((ctx) => gatedAzure.scanMalware(ctx))).toBe(1);
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload.mock.calls[0]?.[1]).toMatchObject({
      fileId: ticket.fileId,
      uploadedBy: "user1",
      status: "ready",
    });
  });

  it("retries a failed scan callback without blocking other clean files", async () => {
    const t = createGatedTest().withIdentity({ subject: "user1" });
    const first = await t.mutation(gatedApi.gatedFiles.generateUploadUrl, {
      contentType: "image/png",
    });
    const second = await t.mutation(gatedApi.gatedFiles.generateUploadUrl, {
      contentType: "image/png",
    });
    stubBlob({});
    await t.action(gatedApi.gatedFiles.confirmUpload, {
      fileId: first.fileId,
    });
    await t.action(gatedApi.gatedFiles.confirmUpload, {
      fileId: second.fileId,
    });
    onUpload.mockRejectedValueOnce(new Error("Temporary callback failure"));
    stubScanResult("No threats found");

    await expect(
      t.action((ctx) => gatedAzure.scanMalware(ctx)),
    ).rejects.toThrow("Failed to process");
    expect(
      (
        await t.query(app.components.azureBlob.lib.get, {
          fileId: first.fileId,
        })
      )?.status,
    ).toBe("scanning");
    expect(
      (
        await t.query(app.components.azureBlob.lib.get, {
          fileId: second.fileId,
        })
      )?.status,
    ).toBe("ready");
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(1);

    gatedNow += 15_000;
    expect(await t.action((ctx) => gatedAzure.scanMalware(ctx))).toBe(1);
    expect(
      (
        await t.query(app.components.azureBlob.lib.get, {
          fileId: first.fileId,
        })
      )?.status,
    ).toBe("ready");
    expect(
      await t.run((ctx) => ctx.db.query("attachments").take(10)),
    ).toHaveLength(2);
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
