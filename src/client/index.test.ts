/// <reference types="vite/client" />
import { convexTest, defineTestApp } from "convex-test";
import {
  defineSchema,
  defineTable,
  internalMutationGeneric,
  httpRouter,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import componentTest, { register } from "../test.js";
import { AzureBlob, DEFAULT_MAX_BYTES } from "./index.js";
import type { AzureBlobOptions, FileDoc } from "./index.js";
import { effectiveUploadExpiry } from "./upload-expiry.js";
import { api as componentApi } from "../component/_generated/api.js";
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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
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

  it("signs a snapshot file instead of serving the public base URL", async () => {
    const state = setup({
      blockUploads: true,
      config: { ...config, publicBaseUrl: "https://cdn.example/up" },
    });
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        size: PNG.length,
      }),
    );
    stubBlocks();
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(true);
    const url = (await state.t.action((ctx) =>
      state.azure.getUrl(ctx, ticket.fileId),
    ))!;
    expect(url.startsWith("http://127.0.0.1:10000/")).toBe(true);
    expect(params(url).get("sr")).toBe("bs");
    expect(params(url).get("snapshot")).toBe("2026-01-01T12:00:00.0000000Z");
    expect(params(url).has("sig")).toBe(true);
  });

  it("signs a Cache-Control override instead of serving the public base URL", async () => {
    const { t, azure, upload } = setup({
      config: { ...config, publicBaseUrl: "https://cdn.example/up" },
    });
    const fileId = await upload();
    const url = (await t.action((ctx) =>
      azure.getUrl(ctx, fileId, { cacheControl: "no-store" }),
    ))!;
    expect(url.startsWith("http://127.0.0.1:10000/")).toBe(true);
    expect(params(url).get("rscc")).toBe("no-store");
    expect(params(url).has("sig")).toBe(true);
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

  it.each([2, undefined])(
    "bounds slow deletes with concurrency %s",
    async (concurrency) => {
      const { t, azure, reserve, advance } = setup();
      for (let i = 0; i < 12; i++) await reserve();
      advance(2 * 60 * MINUTE);
      const started = deferred();
      const release = deferred();
      const bound = concurrency ?? 8;
      let active = 0;
      let maximum = 0;
      fetchMock.mockImplementation(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === bound) started.resolve();
        try {
          await release.promise;
          return new Response(null, { status: 202 });
        } finally {
          active -= 1;
        }
      });
      const sweeping = t.action((ctx) => azure.sweep(ctx, { concurrency }));
      try {
        await started.promise;
        expect(maximum).toBe(bound);
      } finally {
        release.resolve();
      }
      expect(await sweeping).toBe(12);
      expect(maximum).toBe(bound);
    },
  );

  it("schedules full claimed batches up to maxRuns, including failed deletes", async () => {
    const { t, azure, reserve, advance } = setup();
    for (let i = 0; i < 4; i++) await reserve();
    advance(2 * 60 * MINUTE);
    stubBlob({}, 500);
    const continueWith = makeFunctionReference<"action", { run?: number }>(
      "photos:sweep",
    ) as unknown as NonNullable<
      Parameters<AzureBlob["sweep"]>[1]
    >["continueWith"];
    const runAfter = vi.fn(async () => "scheduled" as never);
    const sweep = (run?: number, maxRuns?: number) =>
      t.action((ctx) =>
        azure.sweep(
          { ...ctx, scheduler: { runAfter } },
          { limit: 1, continueWith, run, maxRuns },
        ),
      );
    expect(await sweep()).toBe(0);
    expect(runAfter).toHaveBeenLastCalledWith(0, continueWith, { run: 1 });
    expect(await sweep(8)).toBe(0);
    expect(runAfter).toHaveBeenLastCalledWith(0, continueWith, { run: 9 });
    expect(await sweep(9)).toBe(0);
    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(await sweep(0, 1)).toBe(0);
    expect(runAfter).toHaveBeenCalledTimes(2);
  });

  it("does not schedule a partial batch and supports contexts without a scheduler", async () => {
    const { t, azure, reserve, advance } = setup();
    await reserve();
    advance(2 * 60 * MINUTE);
    stubBlob({});
    const continueWith = makeFunctionReference<"action", { run?: number }>(
      "photos:sweep",
    ) as unknown as NonNullable<
      Parameters<AzureBlob["sweep"]>[1]
    >["continueWith"];
    const runAfter = vi.fn(async () => "scheduled" as never);
    expect(
      await t.action((ctx) =>
        azure.sweep(
          { ...ctx, scheduler: { runAfter } },
          { continueWith, limit: 2 },
        ),
      ),
    ).toBe(1);
    expect(runAfter).not.toHaveBeenCalled();
    expect(
      await t.action((ctx) =>
        azure.sweep({
          runQuery: ctx.runQuery,
          runMutation: ctx.runMutation,
        }),
      ),
    ).toBe(0);
    await expect(
      t.action((ctx) =>
        azure.sweep(
          {
            runQuery: ctx.runQuery,
            runMutation: ctx.runMutation,
          },
          { continueWith },
        ),
      ),
    ).rejects.toThrow("sweep continuation requires a scheduler");
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 1.5 },
    { concurrency: Infinity },
    { run: -1 },
    { maxRuns: 0 },
    { limit: NaN },
  ])("rejects invalid sweep options %j before claiming", async (args) => {
    const { t, azure, reserve, file, advance } = setup();
    const id = await reserve();
    advance(2 * 60 * MINUTE);
    await expect(t.action((ctx) => azure.sweep(ctx, args))).rejects.toThrow();
    expect((await file(id))?.status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defers a failing row so a newer row is swept, with growing capped backoff", async () => {
    const { t, azure, reserve, file, advance } = setup();
    const failing = await reserve();
    advance(MINUTE);
    const newer = await reserve();
    advance(2 * 60 * MINUTE);
    stubBlob({}, 500);
    expect(await t.action((ctx) => azure.sweep(ctx, { limit: 1 }))).toBe(0);
    let now = T0 + 121 * MINUTE;
    expect(await file(failing)).toMatchObject({
      sweepAttempts: 1,
      nextAttemptAt: now + MINUTE,
      status: "deleting",
    });
    stubBlob({});
    expect(await t.action((ctx) => azure.sweep(ctx, { limit: 1 }))).toBe(1);
    expect(await file(newer)).toBeNull();
    expect(await t.action((ctx) => azure.sweep(ctx, { limit: 1 }))).toBe(0);
    stubBlob({}, 500);
    for (let attempts = 2; attempts <= 13; attempts++) {
      const due = (await file(failing))!.nextAttemptAt!;
      advance(due - now);
      now = due;
      expect(await t.action((ctx) => azure.sweep(ctx, { limit: 1 }))).toBe(0);
      expect(await file(failing)).toMatchObject({
        sweepAttempts: attempts,
        nextAttemptAt: now + Math.min(MINUTE * 2 ** (attempts - 1), DAY),
      });
    }
  });

  it("defers a successful delete until the upload expiry plus clock skew", async () => {
    const { t, azure, reserve, file, advance } = setup();
    const id = await reserve();
    stubBlob({});
    expect(await t.action((ctx) => azure.purge(ctx, id))).toBe(true);
    const due = (await file(id))!.uploadExpiresAt! + 5 * MINUTE;
    expect(await file(id)).toMatchObject({
      status: "deleting",
      nextAttemptAt: due,
    });
    expect((await file(id))?.sweepAttempts).toBeUndefined();
    advance(due - T0 - 1);
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(0);
    advance(1);
    expect(await t.action((ctx) => azure.sweep(ctx))).toBe(1);
    expect(await file(id)).toBeNull();
  });

  it("resets failure attempts when a delete is deferred for a live upload URL", async () => {
    const t = convexTest(componentTest.schema, componentTest.modules);
    const fileId = await t.run((ctx) =>
      ctx.db.insert("files", {
        container: "uploads",
        blobName: crypto.randomUUID(),
        contentType: "image/png",
        maxBytes: 1024,
        uploadedBy: "u1",
        status: "deleting",
        createdAt: T0,
        sweepAttempts: 4,
        nextAttemptAt: T0,
      }),
    );
    await t.mutation(componentApi.lib.deferSweep, {
      fileId,
      now: T0,
      nextAttemptAt: T0 + MINUTE,
    });
    const row = await t.run((ctx) => ctx.db.get("files", fileId));
    expect(row).toMatchObject({ nextAttemptAt: T0 + MINUTE });
    expect(row?.sweepAttempts).toBeUndefined();
    await t.mutation(componentApi.lib.deferSweep, { fileId, now: T0 });
    expect(await t.run((ctx) => ctx.db.get("files", fileId))).toMatchObject({
      sweepAttempts: 1,
      nextAttemptAt: T0 + MINUTE,
    });
  });

  it("includes undefined and due nextAttemptAt in the bounded index range, including legacy calls", async () => {
    const t = convexTest(componentTest.schema, componentTest.modules);
    const insert = (nextAttemptAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert("files", {
          container: "uploads",
          blobName: crypto.randomUUID(),
          contentType: "image/png",
          maxBytes: 1024,
          uploadedBy: "u1",
          status: "deleting",
          createdAt: T0 - DAY,
          ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
        }),
      );
    const unset = await insert();
    const overdue = await insert(T0 - 1);
    const due = await insert(T0);
    await insert(T0 + 1);
    const claimed = await t.mutation(componentApi.lib.claimSweepable, {
      pendingBefore: T0 - MINUTE,
      now: T0,
      limit: 10,
    });
    expect(claimed.map((row) => row.fileId)).toEqual([unset, overdue, due]);
    const legacy = await t.mutation(componentApi.lib.claimSweepable, {
      pendingBefore: T0 - MINUTE,
      limit: 10,
    });
    expect(legacy.map((row) => row.fileId)).toEqual([unset]);
    expect(
      await t.mutation(componentApi.lib.claimSweepable, {
        pendingBefore: T0 - MINUTE,
        now: T0,
        limit: 1,
      }),
    ).toHaveLength(1);
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
    async (sourceUrl, reason) => {
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
        reason: expect.stringContaining(reason),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://user:secret-pass@source.example/image.png",
    "https://user@source.example/image.png",
    "https://:secret-pass@source.example/image.png",
  ])(
    "rejects the source URL %s with credentials before reserving or calling Azure",
    async (sourceUrl) => {
      const { t, azure } = setup();
      const result = await t.action((ctx) =>
        azure.storeFromUrl(ctx, {
          sourceUrl,
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("credentials"),
      });
      expect(JSON.stringify(result).includes("secret-pass")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        await t.mutation(azure.component.lib.claimSweepable, {
          pendingBefore: T0 + DAY,
          limit: 10,
          now: T0 + DAY,
        }),
      ).toEqual([]);
    },
  );

  it.each([200, 202])(
    "treats a %s copy answer as a failure and deletes the blob",
    async (status) => {
      const state = setup();
      fetchMock.mockImplementation(async (_url, init) =>
        init?.method === "DELETE"
          ? new Response(null, { status: 202 })
          : new Response(null, { status }),
      );
      expect(
        await state.t.action((ctx) =>
          state.azure.storeFromUrl(ctx, {
            sourceUrl: "https://source.example/image.png",
            contentType: "image/png",
            uploadedBy: "u1",
          }),
        ),
      ).toEqual({
        ok: false,
        reason: `Azure Blob URL copy failed with ${status}`,
      });
      expect(methods()).toEqual(["PUT", "DELETE"]);
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
  it("refreshes only when the cached key has less than twelve hours remaining", async () => {
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

    advance(11 * HOUR);
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    expect(fetchMock).not.toHaveBeenCalled();

    advance(HOUR);
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces the key at the threshold with a fresh 24-hour one", async () => {
    const { t, azure, advance } = setupEntra();
    const cachedKey = (now: number) =>
      t.query(azure.component.lib.getUserDelegationKey, {
        accountName: entraConfig.accountName,
        now,
      });
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const first = await cachedKey(T0);
    expect(Date.parse(first!.signedExpiry)).toBe(T0 - 5 * MINUTE + DAY);

    advance(12 * HOUR);
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const second = await cachedKey(T0 + 12 * HOUR);
    expect(Date.parse(second!.signedExpiry)).toBe(
      T0 + 12 * HOUR - 5 * MINUTE + DAY,
    );
    expect(second!.signedExpiry).not.toBe(first!.signedExpiry);
  });

  it("never leaves a gap in signing across 48 hours of hourly refreshes", async () => {
    const { t, azure, advance } = setupEntra();
    const keyRequests = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("comp=userdelegationkey"),
      ).length;
    const sign = async () => {
      const ticket = await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      );
      expect(params(ticket.uploadUrl).get("skoid")).toBeTruthy();
    };
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    for (let hour = 1; hour <= 48; hour++) {
      advance(HOUR);
      // The cron fires on the hour; signing just before it must still work.
      await sign();
      await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
      await sign();
    }
    expect(keyRequests()).toBeGreaterThanOrEqual(3);
    expect(keyRequests()).toBeLessThanOrEqual(5);
  });

  it("clamps an upload ticket to the cached key's expiry", async () => {
    const { t, azure } = setup({
      config: entraConfig,
      uploadTtlSeconds: 7 * 24 * 60 * 60,
    });
    stubEntra();
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const key = await t.query(azure.component.lib.getUserDelegationKey, {
      accountName: entraConfig.accountName,
      now: T0,
    });
    const keyExpiry = Date.parse(key!.signedExpiry);
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    const se = Date.parse(params(ticket.uploadUrl).get("se")!);
    expect(se).toBeLessThanOrEqual(keyExpiry);
    expect(se).toBeLessThan(T0 + 2 * DAY);
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
          "<UserDelegationKey><SignedOid>99999999-2222-3333-4444-555555555555</SignedOid><SignedTid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</SignedTid><SignedStart>2026-01-01T11:55:00Z</SignedStart><SignedExpiry>2026-01-02T11:55:00Z</SignedExpiry><SignedService>b</SignedService><SignedVersion>2022-11-02</SignedVersion><Value>cmVwbGFjZW1lbnQ=</Value></UserDelegationKey>",
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
    components: { azureBlobStorage: componentTest },
  });
  const azure = new AzureBlob(app.components.azureBlobStorage, {
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
  const checkUploadSpy = vi.fn();
  let gatedNow = T0;
  const app = defineTestApp({
    schema: defineSchema({
      attachments: defineTable({ fileId: v.string(), uploadedBy: v.string() }),
    }),
    components: { azureBlobStorage: componentTest },
  });
  const azure = new AzureBlob(app.components.azureBlobStorage, {
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
        checkUploadSpy(args);
        if (args.fileName === "forbidden.png")
          throw new Error("Quota exceeded");
      },
      onUpload: internal.callbacks.attach,
    }),
  });
  const gatedAzure = new AzureBlob(app.components.azureBlobStorage, {
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
    checkUploadSpy.mockReset();
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
      (await t.query(app.components.azureBlobStorage.lib.get, { fileId }))
        ?.status,
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
        await t.query(app.components.azureBlobStorage.lib.get, {
          fileId: first.fileId,
        })
      )?.status,
    ).toBe("scanning");
    expect(
      (
        await t.query(app.components.azureBlobStorage.lib.get, {
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
        await t.query(app.components.azureBlobStorage.lib.get, {
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

  it("refuses caller-supplied uploadedBy, maxBytes and metadata, and records the signed-in user", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    const claimable = () =>
      t.mutation(app.components.azureBlobStorage.lib.claimSweepable, {
        pendingBefore: T0 + DAY,
        limit: 10,
        now: T0 + DAY,
      });
    for (const extra of [
      { uploadedBy: "victim" },
      { maxBytes: 1e12 },
      { metadata: { role: "admin" } },
    ]) {
      await expect(
        t.mutation(api.files.generateUploadUrl, {
          contentType: "image/png",
          ...extra,
        } as never),
      ).rejects.toThrow(/Unexpected field/);
    }
    expect(checkUploadSpy).not.toHaveBeenCalled();
    expect(await claimable()).toEqual([]);

    const ticket = await t.mutation(api.files.generateUploadUrl, {
      contentType: "image/png",
    });
    expect(checkUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: "user1" }),
    );
    const stored = await t.query(app.components.azureBlobStorage.lib.get, {
      fileId: ticket.fileId,
    });
    expect(stored).toMatchObject({
      uploadedBy: "user1",
      maxBytes: DEFAULT_MAX_BYTES,
    });
    expect(stored?.metadata).toBeUndefined();
    await expect(
      t.mutation(api.files.renewUploadUrl, {
        fileId: ticket.fileId,
        uploadedBy: "victim",
      } as never),
    ).rejects.toThrow(/Unexpected field/);
    await expect(
      t.action(api.files.confirmUpload, {
        fileId: ticket.fileId,
        uploadedBy: "victim",
      } as never),
    ).rejects.toThrow(/Unexpected field/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an anonymous generateUploadUrl before checkUpload, reservation or any Azure call", async () => {
    const anonymous = createTest();
    await expect(
      anonymous.mutation(api.files.generateUploadUrl, {
        contentType: "image/png",
        fileName: "cat.png",
      }),
    ).rejects.toThrow("Not authorized to upload files");
    expect(checkUploadSpy).not.toHaveBeenCalled();
    expect(
      await anonymous.mutation(
        app.components.azureBlobStorage.lib.claimSweepable,
        {
          pendingBefore: T0 + DAY,
          limit: 10,
          now: T0 + DAY,
        },
      ),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an anonymous confirmUpload of a real pending file without any Azure call", async () => {
    const anonymous = createTest();
    const { fileId } = await anonymous
      .withIdentity({ subject: "user1" })
      .mutation(api.files.generateUploadUrl, { contentType: "image/png" });
    stubBlob({});
    await expect(
      anonymous.action(api.files.confirmUpload, { fileId }),
    ).rejects.toThrow("Not authorized to upload files");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUpload).not.toHaveBeenCalled();
    expect(
      (
        await anonymous.query(app.components.azureBlobStorage.lib.get, {
          fileId,
        })
      )?.status,
    ).toBe("pending");
  });

  it("registers scanMalware as an internal action and the upload functions as public", () => {
    const files = azure.clientApi({ identify: async () => "user1" });
    const flags = (fn: object) => fn as { isPublic?: true; isInternal?: true };
    expect(flags(files.scanMalware).isInternal).toBe(true);
    expect(flags(files.scanMalware).isPublic).toBeUndefined();
    for (const fn of [
      files.generateUploadUrl,
      files.renewUploadUrl,
      files.confirmUpload,
    ])
      expect(flags(fn).isPublic).toBe(true);
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

describe("access tiers", () => {
  function stubTier(tier = "Hot", status?: string, tierResponse = 200) {
    stubBlob({});
    const blobFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (params(String(url)).get("comp") === "tier")
        return new Response(null, { status: tierResponse });
      const response = await blobFetch(url, init);
      if (init?.method === "HEAD") {
        response.headers.set("x-ms-access-tier", tier);
        if (status) response.headers.set("x-ms-archive-status", status);
      }
      return response;
    });
  }
  const tierCall = () =>
    fetchMock.mock.calls.find(
      ([url]) => params(String(url)).get("comp") === "tier",
    )!;

  it("applies the default only after confirmation, with write-only server SAS", async () => {
    const { t, azure } = setup({ accessTier: "Cool" });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(ticket.headers).not.toHaveProperty("x-ms-access-tier");
    expect(params(ticket.uploadUrl).get("sp")).toBe("c");
    stubTier();
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true });
    expect(params(String(tierCall()[0])).get("sp")).toBe("w");
    expect(tierCall()[1]).toMatchObject({
      method: "PUT",
      headers: { "x-ms-access-tier": "Cool", "x-ms-version": "2022-11-02" },
    });
    expect(methods()).toEqual(["HEAD", "GET", "PUT"]);
    expect(
      await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
    ).toMatchObject({ status: "ready", accessTier: "Cool" });
    expect(
      (
        await t.query((ctx) =>
          azure.list(ctx, { paginationOpts: { numItems: 10, cursor: null } }),
        )
      ).page[0],
    ).toMatchObject({ accessTier: "Cool" });
  });

  it("keeps failed automatic tiering ready and records the actual HEAD tier", async () => {
    const { t, azure, reserve, file } = setup({ accessTier: "Archive" });
    const fileId = await reserve();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      stubTier("Cool", undefined, 403);
      expect(
        await t.action((ctx) => azure.confirmUpload(ctx, fileId)),
      ).toMatchObject({ ok: true });
      expect(await file(fileId)).toMatchObject({
        status: "ready",
        accessTier: "Cool",
      });
      expect(methods()).toEqual(["HEAD", "GET", "PUT"]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("refreshing its actual tier"),
      );
      expect(await t.query((ctx) => azure.getUrl(ctx, fileId))).not.toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("records HEAD tiers without a constructor default", async () => {
    const { t, azure, reserve, file } = setup();
    const fileId = await reserve();
    stubTier("Cold");
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    expect(await file(fileId)).toMatchObject({ accessTier: "Cold" });
    expect(methods()).toEqual(["HEAD", "GET"]);
  });

  it("sets ready tiers and blocks archived signed and public URLs", async () => {
    const { t, azure, upload, file } = setup({
      config: { ...config, publicBaseUrl: "https://cdn.example.com/uploads" },
    });
    const fileId = await upload();
    stubTier();
    expect(await t.action((ctx) => azure.setTier(ctx, fileId, "Archive"))).toBe(
      true,
    );
    expect((await file(fileId))?.accessTier).toBe("Archive");
    expect(await t.query((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
    expect(
      await t.query((ctx) => azure.getUrl(ctx, fileId, { download: true })),
    ).toBeNull();
    expect(await azure.urlForFile((await file(fileId))!)).toBeNull();
    expect(params(String(tierCall()[0])).get("sp")).toBe("w");
  });

  it("does no Azure work for unknown and non-ready files", async () => {
    const { t, azure, reserve } = setup({ requireMalwareScan: true });
    const fileId = await reserve();
    for (const id of ["invalid", fileId]) {
      expect(await t.action((ctx) => azure.setTier(ctx, id, "Cool"))).toBe(
        false,
      );
      expect(
        await t.action((ctx) => azure.rehydrate(ctx, id, { tier: "Hot" })),
      ).toBe(false);
      expect(await t.action((ctx) => azure.refreshTier(ctx, id))).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    stubBlob({});
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    fetchMock.mockClear();
    expect(await t.action((ctx) => azure.setTier(ctx, fileId, "Cool"))).toBe(
      false,
    );
    await t.mutation((ctx) => azure.markForDeletion(ctx, fileId));
    expect(await t.action((ctx) => azure.setTier(ctx, fileId, "Cool"))).toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["Hot", "Cool", "Cold"] as const)(
    "records 202 rehydration to %s while preserving Archive",
    async (tier) => {
      const { t, azure, upload, file } = setup();
      const fileId = await upload();
      stubTier("Archive", undefined, 202);
      expect(
        await t.action((ctx) =>
          azure.rehydrate(ctx, fileId, { tier, priority: "High" }),
        ),
      ).toBe(true);
      expect(tierCall()[1]).toMatchObject({
        method: "PUT",
        headers: {
          "x-ms-access-tier": tier,
          "x-ms-rehydrate-priority": "High",
        },
      });
      expect(await file(fileId)).toMatchObject({
        accessTier: "Archive",
        archiveStatus: `rehydrate-pending-to-${tier.toLowerCase()}`,
      });
      expect(await t.query((ctx) => azure.getUrl(ctx, fileId))).toBeNull();
    },
  );

  it("defaults priority to Standard and clears archive status on immediate success", async () => {
    const { t, azure, upload, file } = setup();
    const fileId = await upload();
    stubTier("Archive", "rehydrate-pending-to-hot");
    await t.action((ctx) => azure.refreshTier(ctx, fileId));
    expect(
      await t.action((ctx) => azure.rehydrate(ctx, fileId, { tier: "Hot" })),
    ).toBe(true);
    expect(tierCall()[1]?.headers).toMatchObject({
      "x-ms-rehydrate-priority": "Standard",
    });
    expect(await file(fileId)).toMatchObject({ accessTier: "Hot" });
    expect((await file(fileId))?.archiveStatus).toBeUndefined();
  });

  it("refreshes tier and status, then clears absent archive status", async () => {
    const { t, azure, upload, file } = setup();
    const fileId = await upload();
    stubTier("Archive", "rehydrate-pending-to-cool");
    expect(await t.action((ctx) => azure.refreshTier(ctx, fileId))).toBe(true);
    expect(await file(fileId)).toMatchObject({
      accessTier: "Archive",
      archiveStatus: "rehydrate-pending-to-cool",
    });
    expect(params(String(fetchMock.mock.calls[0]![0])).get("sp")).toBe("r");
    stubTier("Cool");
    expect(await t.action((ctx) => azure.refreshTier(ctx, fileId))).toBe(true);
    expect(await file(fileId)).toMatchObject({ accessTier: "Cool" });
    expect((await file(fileId))?.archiveStatus).toBeUndefined();
    expect(await t.query((ctx) => azure.getUrl(ctx, fileId))).not.toBeNull();
  });

  it.each([403, 409, 500])(
    "reports status %s without leaking the URL or SAS",
    async (status) => {
      const { t, azure, upload, file } = setup();
      const fileId = await upload();
      stubTier("Hot", undefined, status);
      await expect(
        t.action((ctx) => azure.setTier(ctx, fileId, "Cool")),
      ).rejects.toThrow(`Azure Blob Set Blob Tier failed with ${status}`);
      await expect(
        t.action((ctx) => azure.rehydrate(ctx, fileId, { tier: "Hot" })),
      ).rejects.toThrow(`Azure Blob Set Blob Tier failed with ${status}`);
      try {
        await t.action((ctx) => azure.setTier(ctx, fileId, "Cool"));
      } catch (error) {
        expect(String(error)).not.toContain("http");
        expect(String(error)).not.toContain("sig=");
      }
      expect((await file(fileId))?.accessTier).toBeUndefined();
    },
  );

  it("sanitizes network failures and reports failed HEAD status", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    fetchMock.mockRejectedValue(
      new Error("https://secret.example/blob?sig=private"),
    );
    await expect(
      t.action((ctx) => azure.setTier(ctx, fileId, "Cool")),
    ).rejects.toThrow("Azure Blob Set Blob Tier request failed");
    await expect(
      t.action((ctx) => azure.refreshTier(ctx, fileId)),
    ).rejects.toThrow("Azure Blob tier HEAD request failed");
    stubBlob({ status: 403 });
    await expect(
      t.action((ctx) => azure.refreshTier(ctx, fileId)),
    ).rejects.toThrow("Azure Blob tier HEAD failed with 403");
  });

  it("tiers and refreshes the verified block snapshot, not the writable base", async () => {
    const { t, azure } = setup({ blockUploads: true, accessTier: "Cold" });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        size: PNG.length,
      }),
    );
    stubBlocks();
    const blockFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      params(String(url)).get("comp") === "tier"
        ? new Response(null, { status: 200 })
        : await blockFetch(url, init),
    );
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true });
    expect(params(String(tierCall()[0])).get("snapshot")).toBe(
      "2026-01-01T12:00:00.0000000Z",
    );
    expect(params(String(tierCall()[0])).get("sr")).toBe("bs");
    fetchMock.mockClear();
    await t.action((ctx) => azure.refreshTier(ctx, ticket.fileId));
    expect(params(String(fetchMock.mock.calls[0]![0])).has("snapshot")).toBe(
      true,
    );
  });

  it("refuses to rehydrate a file known not to be archived, without calling Azure", async () => {
    const { t, azure, reserve } = setup();
    const fileId = await reserve();
    stubTier("Cool");
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    fetchMock.mockClear();
    await expect(
      t.action((ctx) => azure.rehydrate(ctx, fileId, { tier: "Hot" })),
    ).rejects.toThrow("File is not archived");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records the confirm-time tier of a scanned file without an extra HEAD", async () => {
    const { t, azure, reserve, file } = setup({ requireMalwareScan: true });
    const fileId = await reserve();
    stubTier("Cold");
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    expect(await file(fileId)).toMatchObject({
      status: "scanning",
      accessTier: "Cold",
    });
    stubScanResult("No threats found");
    fetchMock.mockClear();
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect(await file(fileId)).toMatchObject({
      status: "ready",
      accessTier: "Cold",
    });
    expect(methods()).not.toContain("HEAD");
  });

  it("applies the default only after a clean malware verdict", async () => {
    const { t, azure, reserve, file } = setup({
      requireMalwareScan: true,
      accessTier: "Cool",
    });
    const fileId = await reserve();
    stubTier();
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    expect(await file(fileId)).toMatchObject({ status: "scanning" });
    expect(methods()).toEqual(["HEAD", "GET"]);
    stubScanResult("No threats found");
    expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
    expect(await file(fileId)).toMatchObject({
      status: "ready",
      accessTier: "Cool",
    });
  });

  it("keeps a clean-scanned file ready when tiering and the tier refresh both fail", async () => {
    const { t, azure, reserve, file } = setup({
      requireMalwareScan: true,
      accessTier: "Cool",
    });
    const fileId = await reserve();
    stubTier();
    await t.action((ctx) => azure.confirmUpload(ctx, fileId));
    stubScanResult("No threats found");
    const scanFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (params(String(url)).get("comp") === "tier")
        return new Response(null, { status: 500 });
      if (init?.method === "HEAD") return new Response(null, { status: 503 });
      return await scanFetch(url, init);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
      expect(await file(fileId)).toMatchObject({ status: "ready" });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("tier refresh failed"),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("applies the default through Event Grid confirmation and makes redelivery harmless", async () => {
    const router = httpRouter();
    const t = convexTest(defineSchema({}), {
      ...componentTest.modules,
      "./component/http.ts": async () => ({ default: router }),
    });
    const azure = new AzureBlob(register(t), {
      config: {
        ...config,
        endpoint: "https://127.0.0.1:10000/devstoreaccount1",
      },
      now: () => T0,
      accessTier: "Cool",
    });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    const doc = (await t.query((ctx) => azure.getFile(ctx, ticket.fileId)))!;
    const secret = "a".repeat(32);
    router.route({
      path: "/events",
      method: "POST",
      handler: azure.eventGridHandler({ secret }),
    });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          id: "tier-event",
          eventType: "Microsoft.Storage.BlobCreated",
          subject: `/blobServices/default/containers/uploads/blobs/${doc.blobName}`,
          eventTime: new Date(T0).toISOString(),
          dataVersion: "",
          metadataVersion: "1",
          data: {
            url: `https://127.0.0.1:10000/devstoreaccount1/uploads/${doc.blobName}`,
          },
        },
      ]),
    };
    stubTier();
    expect((await t.fetch(`/events?secret=${secret}`, request)).status).toBe(
      200,
    );
    expect(
      await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
    ).toMatchObject({ status: "ready", accessTier: "Cool" });
    fetchMock.mockClear();
    expect((await t.fetch(`/events?secret=${secret}`, request)).status).toBe(
      200,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the default to server-side store uploads", async () => {
    const { t, azure } = setup({ accessTier: "Cool" });
    stubTier();
    const result = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok)
      expect(
        await t.query((ctx) => azure.getFile(ctx, result.fileId)),
      ).toMatchObject({ accessTier: "Cool" });
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => params(String(url)).get("comp") === "tier",
      ),
    ).toHaveLength(1);
  });
});

describe("checkSetup", () => {
  const ORIGIN = "https://app.example.com";
  const corsOk = () =>
    new Response(null, {
      status: 200,
      headers: {
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-methods": "PUT",
        "access-control-allow-headers": "x-ms-blob-type,content-type",
      },
    });
  const azureError = (status: number, code: string) =>
    new Response(null, { status, headers: { "x-ms-error-code": code } });

  function stubSetup(probe: () => Response, cors: () => Response = corsOk) {
    const entra = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "OPTIONS") return cors();
      if (init?.method === "HEAD") return probe();
      return await entra!(url, init);
    });
  }
  const blobNotFound = () => azureError(404, "BlobNotFound");
  const names = (checks: { name: string }[]) => checks.map((c) => c.name);

  it("passes every check with a shared key and an origin, probing with a read SAS", async () => {
    const { t, azure } = setup();
    stubSetup(blobNotFound);
    const result = await t.action((ctx) =>
      azure.checkSetup(ctx, { origin: ORIGIN }),
    );
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: "config", ok: true },
        { name: "credentials", ok: true },
        { name: "container", ok: true },
        { name: "cors", ok: true },
      ],
    });
    const head = fetchMock.mock.calls.find(([, i]) => i?.method === "HEAD");
    expect(params(String(head?.[0])).get("sp")).toBe("r");
    const preflight = fetchMock.mock.calls.find(
      ([, i]) => i?.method === "OPTIONS",
    );
    expect(String(preflight?.[0])).not.toContain("?");
    expect(preflight?.[1]?.headers).toMatchObject({
      origin: ORIGIN,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "x-ms-blob-type,content-type",
    });
  });

  it("omits the cors check without an origin", async () => {
    const { t, azure } = setup();
    stubSetup(blobNotFound);
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(names(result.checks)).toEqual([
      "config",
      "credentials",
      "container",
    ]);
    expect(methods()).toEqual(["HEAD"]);
  });

  it("passes with Entra and verifies the delegation key without caching it", async () => {
    const { t, azure } = setupEntra();
    stubSetup(blobNotFound);
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain(
      "userdelegationkey",
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("comp=userdelegationkey"),
      ),
    ).toBe(true);
    expect(
      await t.query(azure.component.lib.getUserDelegationKey, {
        accountName: entraConfig.accountName,
        now: T0,
      }),
    ).toBeNull();
  });

  it.each([
    ["AuthenticationFailed", ["credentials", "container"], /key.*clock/],
    [
      "KeyBasedAuthenticationNotPermitted",
      ["credentials", "container"],
      /Entra/,
    ],
    [
      "AuthorizationPermissionMismatch",
      ["container"],
      /Storage Blob Data Contributor/,
    ],
    ["AuthorizationFailure", ["credentials", "container"], /key.*clock/],
  ])("hints for %s on a shared key", async (code, failedNames, hint) => {
    const { t, azure } = setup();
    stubSetup(() => azureError(403, code));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.ok).toBe(false);
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toEqual(failedNames);
    expect(failed[0]?.hint).toMatch(hint);
  });
  it("hints for a missing role on Entra at the container check", async () => {
    const { t, azure } = setupEntra();
    stubSetup(() => azureError(403, "AuthorizationPermissionMismatch"));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]).toEqual({ name: "credentials", ok: true });
    expect(result.checks[2]).toMatchObject({
      name: "container",
      ok: false,
      hint: expect.stringContaining("Storage Blob Data Contributor"),
    });
  });

  it("fails the container check on ContainerNotFound", async () => {
    const { t, azure } = setup();
    stubSetup(() => azureError(404, "ContainerNotFound"));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]).toEqual({ name: "credentials", ok: true });
    expect(result.checks[2]).toMatchObject({
      name: "container",
      ok: false,
      hint: expect.stringContaining("container does not exist"),
    });
  });

  it("fails cors when the preflight is refused or lacks PUT or a header", async () => {
    const { t, azure } = setup();
    const cases = [
      () => azureError(403, "CorsPreflightFailure"),
      () =>
        new Response(null, {
          headers: {
            "access-control-allow-origin": "https://other.example.com",
            "access-control-allow-methods": "PUT",
            "access-control-allow-headers": "*",
          },
        }),
      () =>
        new Response(null, {
          headers: {
            "access-control-allow-origin": ORIGIN,
            "access-control-allow-methods": "GET",
            "access-control-allow-headers": "*",
          },
        }),
      () =>
        new Response(null, {
          headers: {
            "access-control-allow-origin": ORIGIN,
            "access-control-allow-methods": "PUT",
            "access-control-allow-headers": "content-type",
          },
        }),
    ];
    for (const cors of cases) {
      stubSetup(blobNotFound, cors);
      const result = await t.action((ctx) =>
        azure.checkSetup(ctx, { origin: ORIGIN }),
      );
      expect(result.ok).toBe(false);
      expect(result.checks.at(-1)).toMatchObject({
        name: "cors",
        ok: false,
        hint: expect.stringContaining(`origin ${ORIGIN}`),
      });
    }
  });

  it("accepts a wildcard cors rule", async () => {
    const { t, azure } = setup();
    stubSetup(
      blobNotFound,
      () =>
        new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "PUT",
            "access-control-allow-headers": "*",
          },
        }),
    );
    const result = await t.action((ctx) =>
      azure.checkSetup(ctx, { origin: ORIGIN }),
    );
    expect(result.ok).toBe(true);
  });

  it("names the missing environment variables and skips the rest", async () => {
    const { t, azure } = setup({
      config: { ...config, accountName: "", container: "", endpoint: "" },
    });
    const result = await t.action((ctx) =>
      azure.checkSetup(ctx, { origin: ORIGIN }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        name: "config",
        ok: false,
        hint: expect.stringContaining("AZURE_BLOB_ACCOUNT"),
      },
      { name: "credentials", ok: false, hint: "skipped: config failed" },
      { name: "container", ok: false, hint: "skipped: config failed" },
      { name: "cors", ok: false, hint: "skipped: config failed" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the container check when credentials fail", async () => {
    const { t, azure } = setup();
    stubSetup(() => azureError(403, "AuthenticationFailed"));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[2]).toEqual({
      name: "container",
      ok: false,
      hint: "skipped: credentials failed",
    });
  });

  it("reports an Entra token failure and skips the container", async () => {
    const { t, azure } = setupEntra();
    const entra = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/oauth2/v2.0/token"))
        return new Response("nope", { status: 401 });
      return await entra(url, init);
    });
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]).toMatchObject({
      name: "credentials",
      ok: false,
      hint: expect.stringContaining("token"),
    });
    expect(result.checks[2]?.hint).toBe("skipped: credentials failed");
  });

  it("maps a delegation key permission error to a role hint", async () => {
    const { t, azure } = setupEntra();
    const entra = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("comp=userdelegationkey"))
        return new Response("<Error><Message>denied</Message></Error>", {
          status: 403,
          headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" },
        });
      return await entra(url, init);
    });
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]).toMatchObject({
      name: "credentials",
      ok: false,
      hint: expect.stringContaining("Storage Blob Delegator"),
    });
  });

  it("keeps only the status of the package's own token error", async () => {
    const { t, azure } = setupEntra();
    const entra = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/oauth2/v2.0/token"))
        return new Response("nope", { status: 401 });
      return await entra(url, init);
    });
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]?.hint).toBe(
      "Could not get a Microsoft Entra token: the token request failed with 401",
    );
  });

  it("uses a generic hint when the token request rejects or returns malformed JSON", async () => {
    for (const respond of [
      () => {
        throw new Error(
          "connect failed https://login.example.com/t?code=s3cret",
        );
      },
      () => new Response("{not json s3cret", { status: 200 }),
    ]) {
      const { t, azure } = setupEntra();
      const entra = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url).includes("/oauth2/v2.0/token")) return respond();
        return await entra(url, init);
      });
      const result = await t.action((ctx) => azure.checkSetup(ctx));
      const text = JSON.stringify(result.checks);
      expect(result.checks[1]).toMatchObject({
        name: "credentials",
        ok: false,
      });
      expect(text).not.toMatch(/s3cret|login\.example|https?:\/\/|\?/);
      expect(text).toContain("tenant id, client id, client secret");
    }
  });

  it("probes with a user delegation SAS and no bearer header in Entra mode", async () => {
    const { t, azure } = setupEntra();
    stubSetup(blobNotFound);
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.ok).toBe(true);
    const head = fetchMock.mock.calls.find(([, i]) => i?.method === "HEAD");
    const query = params(String(head?.[0]));
    expect(query.get("sp")).toBe("r");
    expect(query.get("skoid")).toBe("11111111-2222-3333-4444-555555555555");
    expect(query.get("sktid")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(
      Object.keys(head?.[1]?.headers ?? {}).map((name) => name.toLowerCase()),
    ).not.toContain("authorization");
    expect(Date.parse(query.get("se")!) - T0).toBeLessThanOrEqual(MINUTE);
  });

  it.each(["AuthenticationFailed", "AuthorizationFailure"])(
    "points at AZURE_BLOB_ACCOUNT when Entra mode answers %s",
    async (code) => {
      const { t, azure } = setupEntra();
      stubSetup(() => azureError(403, code));
      const result = await t.action((ctx) => azure.checkSetup(ctx));
      expect(result.checks[1]).toMatchObject({
        name: "credentials",
        ok: false,
        hint: expect.stringMatching(/AZURE_BLOB_ACCOUNT.*storage account/),
      });
      expect(result.checks[2]?.hint).toBe("skipped: credentials failed");
    },
  );

  it("reports a malformed account key as a credentials failure, not an unreachable endpoint", async () => {
    const { t, azure } = setup({
      config: { ...config, accountKey: "***not base64***" },
    });
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]).toEqual({
      name: "credentials",
      ok: false,
      hint: expect.stringContaining("not a valid base64 account key"),
    });
    expect(JSON.stringify(result.checks)).not.toContain("unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers both a bad key or clock and the firewall for AuthorizationFailure", async () => {
    const { t, azure } = setup();
    stubSetup(() => azureError(403, "AuthorizationFailure"));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[1]?.hint).toMatch(/key.*clock.*firewall/);
  });

  it.each([
    ["default", {}, {}, "x-ms-blob-type,content-type"],
    [
      "checksum",
      {},
      { checksum: true },
      "x-ms-blob-type,content-type,content-md5",
    ],
    ["block uploads", { blockUploads: true }, {}, "content-type"],
    [
      "block uploads, ignoring checksum",
      { blockUploads: true },
      { checksum: true },
      "content-type",
    ],
  ])(
    "requests the %s upload headers in the preflight",
    async (_name, azureOptions, checkOptions, expected) => {
      const { t, azure } = setup(azureOptions);
      const requested: string[] = [];
      stubSetup(blobNotFound, () => {
        const headers = fetchMock.mock.calls.at(-1)?.[1]?.headers as Record<
          string,
          string
        >;
        requested.push(headers["access-control-request-headers"]!);
        return new Response(null, {
          headers: {
            "access-control-allow-origin": ORIGIN,
            "access-control-allow-methods": "PUT",
            "access-control-allow-headers": expected,
          },
        });
      });
      const ok = await t.action((ctx) =>
        azure.checkSetup(ctx, { origin: ORIGIN, ...checkOptions }),
      );
      expect(ok.ok).toBe(true);
      expect(requested).toEqual([expected]);

      stubSetup(blobNotFound, () => azureError(403, "CorsPreflightFailure"));
      const failed = await t.action((ctx) =>
        azure.checkSetup(ctx, { origin: ORIGIN, ...checkOptions }),
      );
      expect(failed.checks.at(-1)?.hint).toContain(
        `allowed headers ${expected.replaceAll(",", ", ")}`,
      );
    },
  );

  it("rejects a preflight missing content-md5 when checksum is true", async () => {
    const { t, azure } = setup();
    stubSetup(blobNotFound);
    const result = await t.action((ctx) =>
      azure.checkSetup(ctx, { origin: ORIGIN, checksum: true }),
    );
    expect(result.checks.at(-1)).toMatchObject({ name: "cors", ok: false });
  });

  it("states the Delegator and Contributor scopes separately", async () => {
    const { t, azure } = setupEntra();
    stubSetup(() => azureError(403, "AuthorizationPermissionMismatch"));
    const result = await t.action((ctx) => azure.checkSetup(ctx));
    expect(result.checks[2]?.hint).toMatch(
      /Contributor at the storage account or container scope.*Delegator at the storage account scope or above/,
    );
  });
  it("reports an unreachable endpoint without throwing", async () => {
    const { t, azure } = setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await t.action((ctx) =>
      azure.checkSetup(ctx, { origin: ORIGIN }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.slice(1).every((c) => !c.ok)).toBe(true);
    expect(result.checks[1]?.hint).toContain("unreachable");
    expect(result.checks[3]?.hint).toContain("unreachable");
  });

  it("never includes the key, a SAS, a token or a URL in the result", async () => {
    const secrets = [config.accountKey, "access-token", "client-secret"];
    for (const state of [setup(), setupEntra()]) {
      for (const probe of [
        blobNotFound,
        () => azureError(403, "AuthenticationFailed"),
        () => azureError(404, "ContainerNotFound"),
      ]) {
        stubSetup(probe, () => azureError(403, "CorsPreflightFailure"));
        const { checks } = await state.t.action((ctx) =>
          state.azure.checkSetup(ctx, { origin: ORIGIN }),
        );
        const text = JSON.stringify(checks).replaceAll(ORIGIN, "");
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/https?:\/\/|sig=|sv=|se=|\?/);
      }
    }
  });
});

describe("eventGridHandler authentication", () => {
  const secret = "a".repeat(32);
  const unicodeSecret = "é".repeat(32);

  function setupHandler(handlerSecret: string) {
    const router = httpRouter();
    const t = convexTest(defineSchema({}), {
      ...componentTest.modules,
      "./component/http.ts": async () => ({ default: router }),
    });
    const azure = new AzureBlob(register(t), { config, now: () => T0 });
    router.route({
      path: "/events",
      method: "POST",
      handler: azure.eventGridHandler({ secret: handlerSecret }),
    });
    return { t, azure };
  }

  const validationRequest = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      {
        id: "validation",
        eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
        subject: "",
        eventTime: new Date(T0).toISOString(),
        dataVersion: "",
        metadataVersion: "1",
        data: { validationCode: "code-123" },
      },
    ]),
  };

  const rejected: [string, string][] = [
    ["differs only in the last character", `${secret.slice(0, -1)}b`],
    ["differs only in the first character", `b${secret.slice(1)}`],
    ["is a prefix of the secret", secret.slice(0, -1)],
    ["has extra trailing characters", `${secret}a`],
    ["is empty", ""],
  ];

  it.each(rejected)(
    "rejects a secret that %s without touching Azure or the file",
    async (_name, supplied) => {
      const { t, azure } = setupHandler(secret);
      const ticket = await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      );
      const doc = (await t.query((ctx) => azure.getFile(ctx, ticket.fileId)))!;
      fetchMock.mockClear();
      const response = await t.fetch(`/events?secret=${supplied}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            id: "created",
            eventType: "Microsoft.Storage.BlobCreated",
            subject: `/blobServices/default/containers/uploads/blobs/${doc.blobName}`,
            eventTime: new Date(T0).toISOString(),
            dataVersion: "",
            metadataVersion: "1",
            data: {
              url: `https://127.0.0.1:10000/devstoreaccount1/uploads/${doc.blobName}`,
            },
          },
        ]),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        await t.query((ctx) => azure.getFile(ctx, ticket.fileId)),
      ).toMatchObject({ status: "pending" });
    },
  );

  it("rejects a missing secret parameter", async () => {
    const { t } = setupHandler(secret);
    const response = await t.fetch("/events", validationRequest);
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects before reading the body", async () => {
    const { t } = setupHandler(secret);
    const response = await t.fetch("/events?secret=", {
      method: "POST",
      body: "not json",
    });
    expect(response.status).toBe(401);
  });

  it("accepts the correct secret", async () => {
    const { t } = setupHandler(secret);
    const response = await t.fetch(
      `/events?secret=${secret}`,
      validationRequest,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ validationResponse: "code-123" });
  });

  it("matches a multibyte secret and rejects a different multibyte character", async () => {
    const { t } = setupHandler(unicodeSecret);
    const ok = await t.fetch(
      `/events?secret=${encodeURIComponent(unicodeSecret)}`,
      validationRequest,
    );
    expect(ok.status).toBe(200);

    const wrongLast = `${"é".repeat(31)}è`;
    expect(wrongLast.length).toBe(unicodeSecret.length);
    const bad = await t.fetch(
      `/events?secret=${encodeURIComponent(wrongLast)}`,
      validationRequest,
    );
    expect(bad.status).toBe(401);

    const ascii = await t.fetch(
      `/events?secret=${"e".repeat(32)}`,
      validationRequest,
    );
    expect(ascii.status).toBe(401);
  });
});

describe("eventGridHandler event filtering", () => {
  const secret = "a".repeat(32);
  const endpoint = "https://127.0.0.1:10000/devstoreaccount1";
  const event = (
    eventType: string,
    data: Record<string, unknown>,
    id = "event",
  ) => ({
    id,
    eventType,
    subject: "",
    eventTime: new Date(T0).toISOString(),
    dataVersion: "",
    metadataVersion: "1",
    data,
  });
  const created = (url: string, id?: string) =>
    event("Microsoft.Storage.BlobCreated", { url }, id);
  const validation = (id?: string) =>
    event(
      "Microsoft.EventGrid.SubscriptionValidationEvent",
      { validationCode: "code-123" },
      id,
    );
  type RawHandler = {
    _handler: (ctx: unknown, request: Request) => Promise<Response>;
  };

  async function start(configuredEndpoint = endpoint) {
    const router = httpRouter();
    const t = convexTest(defineSchema({}), {
      ...componentTest.modules,
      "./component/http.ts": async () => ({ default: router }),
    });
    const azure = new AzureBlob(register(t), {
      config: { ...config, endpoint: configuredEndpoint },
      now: () => T0,
    });
    const handler = azure.eventGridHandler({ secret });
    router.route({ path: "/events", method: "POST", handler });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    const doc = (await t.query((ctx) => azure.getFile(ctx, ticket.fileId)))!;
    stubBlob({});
    fetchMock.mockClear();
    return {
      doc,
      handler: handler as unknown as RawHandler,
      post: (events: unknown[]) =>
        t.fetch(`/events?secret=${secret}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(events),
        }),
      status: async () =>
        (await t.query((ctx) => azure.getFile(ctx, ticket.fileId)))?.status,
    };
  }

  it("confirms a pending file when the event comes from the configured account", async () => {
    const { doc, post, status } = await start();
    const response = await post([
      created(`${endpoint}/uploads/${doc.blobName}`),
    ]);
    expect(response.status).toBe(200);
    expect(await status()).toBe("ready");
    expect(methods()).toContain("HEAD");
  });

  it("accepts the account's own blob host when the endpoint is a custom domain, and no other account", async () => {
    const { doc, post, status } = await start("https://files.example.com");
    const ignored = await post([
      created(
        `https://otheraccount.blob.core.windows.net/uploads/${doc.blobName}`,
      ),
    ]);
    expect(ignored.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await status()).toBe("pending");
    const accepted = await post([
      created(
        `https://devstoreaccount1.blob.core.windows.net/uploads/${doc.blobName}`,
      ),
    ]);
    expect(accepted.status).toBe(200);
    expect(await status()).toBe("ready");
  });

  it.each(["GET", "PUT", "DELETE"])(
    "answers %s with 405 and an Allow header, before touching the request",
    async (method) => {
      const { handler } = await start();
      const response = await handler._handler(
        {},
        new Request(`https://some.convex.site/events?secret=${secret}`, {
          method,
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a plain-http request even with the right secret and a valid body", async () => {
    const { handler } = await start();
    const response = await handler._handler(
      {},
      new Request(`http://some.convex.site/events?secret=${secret}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([validation()]),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("HTTPS is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a validation event mixed with an upload event", "created"],
    ["two validation events", "validation"],
  ])(
    "rejects a batch with %s without confirming anything",
    async (_n, other) => {
      const { doc, post, status } = await start();
      const response = await post([
        validation("v1"),
        other === "created"
          ? created(`${endpoint}/uploads/${doc.blobName}`, "c1")
          : validation("v2"),
      ]);
      expect(response.status).toBe(400);
      expect(await status()).toBe("pending");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "another host",
      (name: string) => `https://evil.example/devstoreaccount1/uploads/${name}`,
    ],
    [
      "another port",
      (name: string) =>
        `https://127.0.0.1:10001/devstoreaccount1/uploads/${name}`,
    ],
    [
      "a look-alike subdomain",
      (name: string) =>
        `https://127.0.0.1.evil.example:10000/devstoreaccount1/uploads/${name}`,
    ],
    [
      "credentials pointing elsewhere",
      (name: string) =>
        `https://127.0.0.1:10000@evil.example/devstoreaccount1/uploads/${name}`,
    ],
    [
      "another storage account",
      (name: string) => `https://other.blob.core.windows.net/uploads/${name}`,
    ],
    ["another container", (name: string) => `${endpoint}/other/${name}`],
  ])("acknowledges but ignores an event from %s", async (_name, urlFor) => {
    const { doc, post, status } = await start();
    const response = await post([created(urlFor(doc.blobName))]);
    expect(response.status).toBe(200);
    expect(await status()).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a leading encoded dot-dot segment",
      (name: string) => `${endpoint}/uploads/..%2f${name}`,
    ],
    [
      "an encoded dot-dot between segments",
      (name: string) => `${endpoint}/uploads/x%2f..%2f${name}`,
    ],
    [
      "an encoded slash inside the container",
      (name: string) => `${endpoint}/uploads%2f${name}`,
    ],
    [
      "an encoded slash inside the account path",
      (name: string) =>
        `https://127.0.0.1:10000/devstoreaccount1%2f..%2fdevstoreaccount1/uploads/${name}`,
    ],
  ])("acknowledges but ignores a path with %s", async (_name, urlFor) => {
    const { doc, post, status } = await start();
    const response = await post([created(urlFor(doc.blobName))]);
    expect(response.status).toBe(200);
    expect(await status()).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a whole batch holding a plain-http BlobCreated URL, leaving its valid events pending", async () => {
    const { doc, post, status } = await start();
    const response = await post([
      created(`${endpoint}/uploads/${doc.blobName}`, "good"),
      created(
        `http://127.0.0.1:10000/devstoreaccount1/uploads/${doc.blobName}`,
        "plain",
      ),
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Event Grid event schema");
    expect(await status()).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("delegation key safety", () => {
  const KEY_VALUE = "dGVzdC1kZWxlZ2F0aW9uLWtleQ==";
  const key = (signedExpiry: string) => ({
    keyValue: KEY_VALUE,
    signedObjectId: "11111111-2222-3333-4444-555555555555",
    signedTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    signedStart: "2026-01-01T11:00:00Z",
    signedExpiry,
    signedService: "b",
    signedVersion: "2022-11-02",
  });
  const cache = (state: ReturnType<typeof setup>, signedExpiry: string) =>
    state.t.mutation(state.azure.component.lib.upsertUserDelegationKey, {
      accountName: entraConfig.accountName,
      ...key(signedExpiry),
    });
  const cached = (state: ReturnType<typeof setup>) =>
    state.t.query(state.azure.component.lib.getUserDelegationKey, {
      accountName: entraConfig.accountName,
      now: T0,
    });
  const claimable = (state: ReturnType<typeof setup>) =>
    state.t.mutation(state.azure.component.lib.claimSweepable, {
      pendingBefore: T0 + DAY,
      limit: 10,
      now: T0 + DAY,
    });

  it.each([
    ["exactly now", "2026-01-01T12:00:00Z"],
    ["in the past", "2025-12-31T12:00:00Z"],
  ])(
    "refuses a key Azure returns already expired (%s) and keeps the cached one",
    async (_name, expiry) => {
      const state = setupEntra();
      await state.t.action((ctx) => state.azure.refreshUserDelegationKey(ctx));
      const first = await cached(state);
      const entra = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url).includes("comp=userdelegationkey"))
          return new Response(`<UserDelegationKey>
            <SignedOid>99999999-2222-3333-4444-555555555555</SignedOid>
            <SignedTid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</SignedTid>
            <SignedStart>2025-12-30T12:00:00Z</SignedStart>
            <SignedExpiry>${expiry}</SignedExpiry>
            <SignedService>b</SignedService>
            <SignedVersion>2022-11-02</SignedVersion>
            <Value>ZXhwaXJlZA==</Value>
          </UserDelegationKey>`);
        return await entra(url, init);
      });
      await expect(
        state.t.action((ctx) =>
          state.azure.refreshUserDelegationKey(ctx, { force: true }),
        ),
      ).rejects.toThrow("expired user delegation key");
      expect(first).not.toBeNull();
      expect((await cached(state))?.keyValue === first?.keyValue).toBe(true);
      expect((await cached(state))?.signedObjectId).toBe(first?.signedObjectId);
    },
  );

  it("never puts the key value in tickets, read URLs, errors or setup results", async () => {
    const state = setupEntra({ length: PNG.length });
    await state.t.action((ctx) => state.azure.refreshUserDelegationKey(ctx));
    const seen: string[] = [];
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    seen.push(JSON.stringify(ticket));
    seen.push(
      JSON.stringify(
        await state.t.action((ctx) =>
          state.azure.renewUploadUrl(ctx, {
            fileId: ticket.fileId,
            uploadedBy: "u1",
          }),
        ),
      ),
    );
    await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, ticket.fileId),
    );
    seen.push(
      (await state.t.action((ctx) =>
        state.azure.getUrl(ctx, ticket.fileId, { download: true }),
      ))!,
    );
    const entra = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      init?.method === "HEAD"
        ? new Response(null, {
            status: 404,
            headers: { "x-ms-error-code": "BlobNotFound" },
          })
        : await entra(url, init),
    );
    seen.push(
      JSON.stringify(
        await state.t.action((ctx) => state.azure.checkSetup(ctx)),
      ),
    );
    fetchMock.mockImplementation(async (url, init) =>
      String(url).includes("comp=userdelegationkey")
        ? new Response("<UserDelegationKey></UserDelegationKey>")
        : await entra(url, init),
    );
    seen.push(
      String(
        await state.t
          .action((ctx) =>
            state.azure.refreshUserDelegationKey(ctx, { force: true }),
          )
          .catch((error: unknown) => error),
      ),
    );
    expect(seen).toHaveLength(5);
    for (const secret of [
      KEY_VALUE,
      encodeURIComponent(KEY_VALUE),
      atob(KEY_VALUE),
    ])
      for (const text of seen) expect(text.includes(secret)).toBe(false);
  });

  it("refuses to issue a ticket when the cached key expires within a minute, reserving nothing", async () => {
    const state = setupEntra();
    await cache(state, "2026-01-01T12:01:00Z");
    await expect(
      state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    ).rejects.toThrow("expires too soon; run refreshUserDelegationKey");
    expect(await claimable(state)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    await cache(state, "2026-01-01T12:01:01Z");
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(ticket.uploadUrl).get("se")).toBe("2026-01-01T12:01:01Z");
  });

  it("refuses to renew when the cached key expires within a minute, leaving the row unchanged", async () => {
    const state = setupEntra();
    await state.t.action((ctx) => state.azure.refreshUserDelegationKey(ctx));
    const fileId = await state.reserve();
    const before = await state.file(fileId);
    await cache(state, "2026-01-01T12:01:00Z");
    state.advance(MINUTE / 2);
    await expect(
      state.t.action((ctx) =>
        state.azure.renewUploadUrl(ctx, { fileId, uploadedBy: "u1" }),
      ),
    ).rejects.toThrow("expires too soon; run refreshUserDelegationKey");
    expect((await state.file(fileId))?.uploadExpiresAt).toBe(
      before?.uploadExpiresAt,
    );
  });

  it("never signs a renewal or a read URL past the cached key's expiry", async () => {
    const state = setup({
      config: entraConfig,
      uploadTtlSeconds: 24 * 60 * 60,
      readWindowSeconds: 24 * 60 * 60,
    });
    stubEntra({ length: PNG.length });
    const keyExpiry = Date.parse("2026-01-01T12:10:00Z");
    await cache(state, "2026-01-01T12:10:00Z");
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(Date.parse(params(ticket.uploadUrl).get("se")!)).toBe(keyExpiry);
    state.advance(MINUTE);
    const renewed = await state.t.action((ctx) =>
      state.azure.renewUploadUrl(ctx, {
        fileId: ticket.fileId,
        uploadedBy: "u1",
      }),
    );
    expect(Date.parse(params(renewed.uploadUrl).get("se")!)).toBe(keyExpiry);
    expect(
      (await state.file(ticket.fileId))?.uploadExpiresAt,
    ).toBeLessThanOrEqual(keyExpiry);

    await state.t.action((ctx) =>
      state.azure.confirmUpload(ctx, ticket.fileId),
    );
    const readUrl = await state.t.action((ctx) =>
      state.azure.getUrl(ctx, ticket.fileId),
    );
    expect(Date.parse(params(readUrl).get("se")!)).toBeLessThanOrEqual(
      keyExpiry,
    );
  });
});

describe("SAS protocol and scope", () => {
  const httpsEndpoint = "https://acct.blob.core.windows.net";
  const spr = (url: string | URL) => params(String(url)).get("spr");

  it.each([
    ["an https endpoint", "https", { endpoint: httpsEndpoint }, undefined],
    [
      "an http endpoint with httpsOnly",
      "https",
      { endpoint: config.endpoint },
      true,
    ],
    [
      "an https endpoint with httpsOnly off",
      null,
      { endpoint: httpsEndpoint },
      false,
    ],
  ])(
    "signs upload, read and server SAS URLs for %s with spr=%s",
    async (_name, expected, override, httpsOnly) => {
      const state = setup({
        config: { ...config, ...override },
        ...(httpsOnly === undefined ? {} : { httpsOnly }),
      });
      const ticket = await state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      );
      expect(spr(ticket.uploadUrl)).toBe(expected);
      stubBlob({});
      await state.t.action((ctx) =>
        state.azure.confirmUpload(ctx, ticket.fileId),
      );
      const readUrl = await state.t.action((ctx) =>
        state.azure.getUrl(ctx, ticket.fileId),
      );
      expect(spr(readUrl!)).toBe(expected);
      const downloadUrl = await state.t.action((ctx) =>
        state.azure.getUrl(ctx, ticket.fileId, { download: true }),
      );
      expect(spr(downloadUrl!)).toBe(expected);
      await state.t.action((ctx) => state.azure.purge(ctx, ticket.fileId));
      expect(methods()).toEqual(["HEAD", "GET", "DELETE"]);
      for (const [url] of fetchMock.mock.calls) expect(spr(url)).toBe(expected);
    },
  );

  it("signs delegation SAS URLs with spr=https on an https endpoint, and omits it when httpsOnly is off", async () => {
    for (const [httpsOnly, expected] of [
      [undefined, "https"],
      [false, null],
    ] as const) {
      const state = setup({
        config: entraConfig,
        ...(httpsOnly === undefined ? {} : { httpsOnly }),
      });
      stubEntra();
      await state.t.action((ctx) => state.azure.refreshUserDelegationKey(ctx));
      const ticket = await state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      );
      expect(spr(ticket.uploadUrl)).toBe(expected);
      await state.t.action((ctx) =>
        state.azure.confirmUpload(ctx, ticket.fileId),
      );
      expect(
        spr(
          (await state.t.action((ctx) =>
            state.azure.getUrl(ctx, ticket.fileId),
          ))!,
        ),
      ).toBe(expected);
    }
  });

  it("backdates the upload start by five minutes and keeps it on a renewed ticket", async () => {
    const state = setup();
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(ticket.uploadUrl).get("st")).toBe("2026-01-01T11:55:00Z");
    state.advance(2 * MINUTE);
    const renewed = await state.t.action((ctx) =>
      state.azure.renewUploadUrl(ctx, {
        fileId: ticket.fileId,
        uploadedBy: "u1",
      }),
    );
    expect(params(renewed.uploadUrl).get("st")).toBe("2026-01-01T11:57:00Z");
    expect(params(renewed.uploadUrl).get("sp")).toBe("c");
  });

  it("renews a block ticket with write-only permission on the same blob", async () => {
    const state = setup({ blockUploads: true });
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        size: PNG.length,
      }),
    );
    state.advance(2 * MINUTE);
    const renewed = await state.t.action((ctx) =>
      state.azure.renewUploadUrl(ctx, {
        fileId: ticket.fileId,
        uploadedBy: "u1",
      }),
    );
    expect(renewed.kind).toBe("blocks");
    expect(params(renewed.uploadUrl).get("sp")).toBe("w");
    expect(params(renewed.uploadUrl).get("sr")).toBe("b");
    expect(new URL(renewed.uploadUrl).pathname).toBe(
      new URL(ticket.uploadUrl).pathname,
    );
  });
});

describe("Azure request failures", () => {
  // Rejects every matching call with a message that carries the full request URL, as undici can.
  function rejectWhen(match: (url: URL, init?: RequestInit) => boolean) {
    const inner = fetchMock.getMockImplementation()!;
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (match(new URL(String(url)), init)) {
        urls.push(String(url));
        throw new TypeError(`fetch failed for ${String(url)}`);
      }
      return await inner(url, init);
    });
    return urls;
  }
  const caught = (run: () => Promise<unknown>) =>
    run().then(
      () => undefined,
      (error: unknown) => error,
    );
  function expectSanitized(error: unknown, expected: string, urls: string[]) {
    expect(urls.length).toBeGreaterThan(0);
    const message =
      error instanceof AggregateError
        ? (error.errors as Error[]).map((e) => e.message).join("\n")
        : String((error as Error | undefined)?.message);
    for (const url of urls) {
      const sig = new URL(url).searchParams.get("sig");
      expect(sig).toBeTruthy();
      expect(message.includes(url)).toBe(false);
      expect(message.includes(sig ?? "")).toBe(false);
    }
    expect(message).toContain(expected);
  }
  const isMethod = (method: string) => (_url: URL, init?: RequestInit) =>
    (init?.method ?? "GET") === method;

  it("hides the SAS URL when reading a file fails", async () => {
    const state = setup();
    const fileId = await state.upload();
    const urls = rejectWhen(isMethod("GET"));
    const error = await caught(() =>
      state.t.action((ctx) => state.azure.read(ctx, fileId)),
    );
    expectSanitized(error, "Azure Blob read request failed", urls);
  });

  it("hides the SAS URL when the confirm HEAD fails", async () => {
    const state = setup();
    const fileId = await state.reserve();
    stubBlob({});
    const urls = rejectWhen(isMethod("HEAD"));
    const error = await caught(() =>
      state.t.action((ctx) => state.azure.confirmUpload(ctx, fileId)),
    );
    expectSanitized(error, "Azure Blob HEAD request failed", urls);
    expect((await state.file(fileId))?.status).toBe("pending");
  });

  it("hides the SAS URL when the signature sniff fails", async () => {
    const state = setup();
    const fileId = await state.reserve();
    stubBlob({});
    const urls = rejectWhen(isMethod("GET"));
    const error = await caught(() =>
      state.t.action((ctx) => state.azure.confirmUpload(ctx, fileId)),
    );
    expectSanitized(error, "Azure Blob GET request failed", urls);
    expect((await state.file(fileId))?.status).toBe("pending");
  });

  it("hides the SAS URL when a server-side upload fails", async () => {
    const state = setup();
    stubBlob({});
    const urls = rejectWhen(isMethod("PUT"));
    const error = await caught(() =>
      state.t.action((ctx) =>
        state.azure.store(ctx, {
          data: PNG,
          contentType: "image/png",
          uploadedBy: "u1",
        }),
      ),
    );
    expectSanitized(error, "Azure Blob upload request failed", urls);
  });

  it.each([
    [
      "block list",
      (url: URL, init?: RequestInit) =>
        url.searchParams.get("comp") === "blocklist" && init?.method !== "PUT",
    ],
    [
      "HEAD",
      (url: URL, init?: RequestInit) =>
        init?.method === "HEAD" && !url.searchParams.has("snapshot"),
    ],
    [
      "block commit",
      (url: URL, init?: RequestInit) =>
        url.searchParams.get("comp") === "blocklist" && init?.method === "PUT",
    ],
    ["snapshot", (url: URL) => url.searchParams.get("comp") === "snapshot"],
  ])(
    "hides the SAS URL when the block-upload %s request fails",
    async (operation, match) => {
      const state = setup({ blockUploads: true });
      const ticket = await state.t.action((ctx) =>
        state.azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          size: PNG.length,
        }),
      );
      stubBlocks();
      const urls = rejectWhen(match);
      const error = await caught(() =>
        state.t.action((ctx) => state.azure.confirmUpload(ctx, ticket.fileId)),
      );
      expectSanitized(error, `Azure Blob ${operation} request failed`, urls);
      expect((await state.file(ticket.fileId))?.status).toBe("pending");
    },
  );

  it("hides the SAS URL when the malware tag read fails, and retries later", async () => {
    const state = setup({ requireMalwareScan: true });
    const fileId = await state.reserve();
    stubBlob({});
    await state.t.action((ctx) => state.azure.confirmUpload(ctx, fileId));
    const urls = rejectWhen(
      (url, init) =>
        init?.method === "GET" && url.searchParams.get("comp") === "tags",
    );
    const error = await caught(() =>
      state.t.action((ctx) => state.azure.scanMalware(ctx)),
    );
    expectSanitized(error, "Azure Blob tag read request failed", urls);
    expect((await state.file(fileId))?.status).toBe("scanning");
  });

  it("hides the SAS URL when deleting a malicious blob fails, and keeps cleanup pending", async () => {
    const state = setup({ requireMalwareScan: true });
    const fileId = await state.reserve();
    stubBlob({});
    await state.t.action((ctx) => state.azure.confirmUpload(ctx, fileId));
    stubScanResult("Malicious");
    const urls = rejectWhen(isMethod("DELETE"));
    const error = await caught(() =>
      state.t.action((ctx) => state.azure.scanMalware(ctx)),
    );
    expectSanitized(error, "Azure Blob delete request failed", urls);
    expect((await state.file(fileId))?.status).toBe("rejected");
  });

  it("defers a purge whose delete request rejects instead of throwing", async () => {
    const state = setup();
    const fileId = await state.upload();
    const urls = rejectWhen(isMethod("DELETE"));
    expect(await state.t.action((ctx) => state.azure.purge(ctx, fileId))).toBe(
      false,
    );
    expect(urls).toHaveLength(1);
    expect(await state.file(fileId)).toMatchObject({
      status: "deleting",
      sweepAttempts: 1,
      nextAttemptAt: T0 + MINUTE,
    });
  });
});

describe("limits and validation", () => {
  it.each([0, -1, NaN, Infinity, 604_801])(
    "rejects a TTL or read window of %s seconds",
    (seconds) => {
      const component = {} as never;
      expect(
        () => new AzureBlob(component, { uploadTtlSeconds: seconds }),
      ).toThrow("Upload TTL must be between 0 and 604800 seconds");
      expect(
        () =>
          new AzureBlob(component, {
            uploadTtlSeconds: seconds,
            blockUploads: true,
          }),
      ).toThrow("Block upload TTL must be between 0 and 604800 seconds");
      expect(
        () => new AzureBlob(component, { readWindowSeconds: seconds }),
      ).toThrow("Read window must be between 0 and 604800 seconds");
    },
  );

  it("accepts the smallest and largest TTL and read window", () => {
    const component = {} as never;
    for (const seconds of [1, 604_800])
      expect(
        () =>
          new AzureBlob(component, {
            uploadTtlSeconds: seconds,
            readWindowSeconds: seconds,
          }),
      ).not.toThrow();
  });

  it("rejects a path prefix with dot segments, control characters or other separators", () => {
    const component = {} as never;
    for (const pathPrefix of [
      "a/../b",
      "a/./b",
      "x\n",
      "a\nb",
      "a\\b",
      "a%2fb",
      "é",
    ])
      expect(() => new AzureBlob(component, { pathPrefix })).toThrow(
        "Invalid pathPrefix",
      );
  });

  it("accepts a 1024-character metadata value and rejects 1025", async () => {
    const { t, azure } = setup();
    const reserve = (value: string) =>
      t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "u1",
          metadata: { note: value },
        }),
      );
    await expect(reserve("x".repeat(1024))).resolves.toMatchObject({
      fileId: expect.any(String),
    });
    await expect(reserve("x".repeat(1025))).rejects.toThrow("exceeds 1024");
  });

  it("refuses renewals that expire in the past or more than seven days out", async () => {
    const state = setup();
    const fileId = await state.reserve();
    const renew = (now: number, expiresAt: number) =>
      state.t.mutation(state.azure.component.lib.renewUpload, {
        fileId,
        uploadedBy: "u1",
        now,
        expiresAt,
      });
    for (const expiresAt of [T0, T0 - MINUTE, T0 + 7 * DAY + 1, Infinity, NaN])
      await expect(renew(T0, expiresAt)).rejects.toThrow(
        "Invalid upload expiry",
      );
    await expect(renew(NaN, T0 + MINUTE)).rejects.toThrow(
      "Invalid upload expiry",
    );
    expect(await renew(T0, T0 + 7 * DAY)).toMatchObject({
      uploadExpiresAt: T0 + 7 * DAY,
    });
  });

  async function seedPending(state: ReturnType<typeof setup>, count: number) {
    for (let i = 0; i < count; i++)
      await state.t.mutation(state.azure.component.lib.create, {
        container: "uploads",
        blobName: `bulk-${i}.png`,
        contentType: "image/png",
        maxBytes: 1000,
        uploadedBy: "u1",
        createdAt: T0,
        uploadExpiresAt: T0 + 5 * MINUTE,
      });
  }

  it("claims at most 200 files in the component however large the limit", async () => {
    const state = setup();
    await seedPending(state, 205);
    const claimed = await state.t.mutation(
      state.azure.component.lib.claimSweepable,
      { pendingBefore: T0 + DAY, limit: 1e9, now: T0 + DAY },
    );
    expect(claimed).toHaveLength(200);
  });

  it("removes at most 200 files per client sweep however large the limit", async () => {
    const state = setup();
    await seedPending(state, 205);
    state.advance(DAY);
    stubBlob({});
    expect(
      await state.t.action((ctx) =>
        state.azure.sweep(ctx, { limit: 1e9, pendingOlderThanMs: 0 }),
      ),
    ).toBe(200);
    expect(
      await state.t.action((ctx) =>
        state.azure.sweep(ctx, { limit: 1e9, pendingOlderThanMs: 0 }),
      ),
    ).toBe(5);
  });

  it("claims at least one file when the limit is zero or negative", async () => {
    const state = setup();
    for (let i = 0; i < 3; i++) await state.reserve();
    for (const limit of [0, -5]) {
      const claimed = await state.t.mutation(
        state.azure.component.lib.claimSweepable,
        { pendingBefore: T0 + DAY, limit, now: T0 + DAY },
      );
      expect(claimed).toHaveLength(1);
    }
  });

  it("will not mark a scan-gated pending file ready without passing through scanning", async () => {
    const state = setup({ requireMalwareScan: true });
    const fileId = await state.reserve();
    expect(
      await state.t.mutation(state.azure.component.lib.markReady, {
        fileId,
        size: PNG.length,
      }),
    ).toBeNull();
    expect((await state.file(fileId))?.status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("blob index tags", () => {
  function stubTags(existing: Record<string, string> = {}, status = 204) {
    const blobFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (params(String(url)).get("comp") === "tags") {
        if (init?.method === "PUT") return new Response(null, { status });
        return new Response(
          `<Tags><TagSet>${Object.entries(existing)
            .map(
              ([key, value]) =>
                `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`,
            )
            .join("")}</TagSet></Tags>`,
        );
      }
      return await blobFetch(url, init);
    });
  }
  const writes = () =>
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        params(String(url)).get("comp") === "tags" && init?.method === "PUT",
    );
  const reserveTags = (
    t: ReturnType<typeof setup>["t"],
    azure: AzureBlob,
    tags: Record<string, string>,
  ) =>
    t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
        tags,
        size: PNG.length,
      }),
    );

  it.each([
    [
      "too many",
      Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])),
    ],
    ["empty key", { "": "v" }],
    ["long key", { ["k".repeat(129)]: "v" }],
    ["long value", { key: "v".repeat(257) }],
    ["bad key character", { "key&": "v" }],
    ["bad value character", { key: "<secret>" }],
    ["non ASCII", { key: "é" }],
    ["trailing key newline", { "key\n": "value" }],
    ["trailing value newline", { key: "value\n" }],
    ["non string", { key: 1 }],
    ["non record", null],
  ])(
    "rejects %s tags before any upload or auth request",
    async (_label, invalid) => {
      const { t, azure } = setup({ config: entraConfig });
      const common = {
        contentType: "image/png",
        uploadedBy: "u1",
        tags: invalid as Record<string, string>,
      };
      await expect(
        t.action((ctx) => azure.generateUploadUrl(ctx, common)),
      ).rejects.toThrow();
      await expect(
        t.action((ctx) => azure.store(ctx, { ...common, data: PNG })),
      ).rejects.toThrow();
      await expect(
        t.action((ctx) =>
          azure.storeFromUrl(ctx, {
            ...common,
            sourceUrl: "https://example.com/image.png",
          }),
        ),
      ).rejects.toThrow();
      await expect(
        t.action((ctx) => azure.setTags(ctx, "unknown", common.tags)),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts boundary lengths and allowed characters without browser tag headers", async () => {
    const { t, azure, file } = setup();
    const tags = {
      ["k".repeat(128)]: "v".repeat(256),
      "azAZ09 +-.:=_/": "",
      empty: "azAZ09 +-.:=_/",
    };
    const ticket = await reserveTags(t, azure, tags);
    expect(await file(ticket.fileId)).toMatchObject({
      tags,
      status: "pending",
    });
    expect(
      Object.keys(ticket.headers).some((key) =>
        key.toLowerCase().includes("tag"),
      ),
    ).toBe(false);
    expect(params(ticket.uploadUrl).get("sp")).toBe("c");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes on confirm and replaces app-managed keys while retaining Defender tags", async () => {
    const { t, azure, file } = setup();
    const ticket = await reserveTags(t, azure, {
      project: "old",
      obsolete: "remove",
    });
    stubBlob({});
    stubTags({ "Malware scanning scan result": "No threats found" });
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0]!;
    expect(params(String(url)).get("sp")).toBe("t");
    expect(new Headers(init?.headers).get("x-ms-version")).toBe("2022-11-02");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/xml; charset=UTF-8",
    );
    expect(init?.body).toContain(
      "<Key>Malware scanning scan result</Key><Value>No threats found</Value>",
    );
    expect(init?.body).toContain("<Key>project</Key><Value>old</Value>");
    stubTags({
      "Malware scanning scan result": "No threats found",
      project: "old",
      obsolete: "remove",
      external: "keep",
    });
    expect(
      await t.action((ctx) =>
        azure.setTags(ctx, ticket.fileId, { project: "new" }),
      ),
    ).toBe(true);
    const body = writes().at(-1)![1]!.body;
    expect(body).toContain("<Key>external</Key><Value>keep</Value>");
    expect(body).toContain("<Key>Malware scanning scan result</Key>");
    expect(body).toContain("<Key>project</Key><Value>new</Value>");
    expect(body).not.toContain("obsolete");
    expect(await file(ticket.fileId)).toMatchObject({
      tags: { project: "new" },
      status: "ready",
    });
    stubTags({ project: "new", external: "keep" });
    expect(await t.action((ctx) => azure.setTags(ctx, ticket.fileId, {}))).toBe(
      true,
    );
    expect(writes().at(-1)![1]?.body).not.toContain("project");
  });

  it("reads Azure tags including XML entities and empty values rather than row tags", async () => {
    const { t, azure, upload } = setup();
    const fileId = await upload();
    fetchMock.mockResolvedValue(
      new Response(
        "<Tags><TagSet><Tag><Key>external</Key><Value>a&#x2f;b&#32;c</Value></Tag><Tag><Key>empty</Key><Value /></Tag></TagSet></Tags>",
      ),
    );
    expect(await t.action((ctx) => azure.getTags(ctx, fileId))).toEqual({
      external: "a/b c",
      empty: "",
    });
  });

  it("returns null or false for unknown and non-ready files without Azure requests", async () => {
    const { t, azure, reserve } = setup();
    const fileId = await reserve();
    for (const id of ["unknown", fileId]) {
      expect(await t.action((ctx) => azure.getTags(ctx, id))).toBeNull();
      expect(
        await t.action((ctx) => azure.setTags(ctx, id, { project: "new" })),
      ).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT"])(
    "reports %s non-2xx with status only and does not update row",
    async (method) => {
      const { t, azure, upload, file } = setup();
      const fileId = await upload();
      fetchMock.mockImplementation(async (_url, init) =>
        init?.method === method
          ? new Response("https://example.com/?sig=secret", { status: 503 })
          : new Response("<Tags><TagSet/></Tags>"),
      );
      try {
        await t.action((ctx) =>
          method === "GET"
            ? azure.getTags(ctx, fileId)
            : azure.setTags(ctx, fileId, { project: "new" }),
        );
        expect.unreachable("non-2xx must throw");
      } catch (error) {
        const message = String(error);
        expect(message).toContain(
          `Azure Blob tag ${method === "GET" ? "read" : "write"} failed with 503`,
        );
        expect(message).not.toMatch(/sig=|https?:|secret/);
      }
      expect((await file(fileId))?.tags).toBeUndefined();
      expect(await file(fileId)).toMatchObject({ status: "ready" });
    },
  );

  it("sanitizes transport errors without applying explicit updates", async () => {
    const { t, azure, upload, file } = setup();
    const fileId = await upload();
    fetchMock.mockRejectedValue(new Error("https://example.com/?sig=secret"));
    await expect(t.action((ctx) => azure.getTags(ctx, fileId))).rejects.toThrow(
      "Azure Blob tag read request failed",
    );
    await expect(
      t.action((ctx) => azure.setTags(ctx, fileId, {})),
    ).rejects.toThrow("Azure Blob tag read request failed");
    expect((await file(fileId))?.tags).toBeUndefined();
  });

  it.each(["failure", "merged limit"])(
    "retains ready state and logs sanitized automatic %s",
    async (kind) => {
      const { t, azure, file } = setup();
      const ticket = await reserveTags(t, azure, { project: "new" });
      stubBlob({});
      stubTags(
        kind === "merged limit"
          ? Object.fromEntries(
              Array.from({ length: 10 }, (_, i) => [`external${i}`, "v"]),
            )
          : {},
        503,
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(
          await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
        ).toMatchObject({ ok: true });
        expect(await file(ticket.fileId)).toMatchObject({
          status: "ready",
          tags: { project: "new" },
        });
        expect(log).toHaveBeenCalledWith(
          "Azure Blob tag write failed after becoming ready; retaining ready file",
        );
        if (kind === "merged limit") {
          expect(writes()).toHaveLength(0);
          await expect(
            t.action((ctx) =>
              azure.setTags(ctx, ticket.fileId, { project: "new" }),
            ),
          ).rejects.toThrow("limited to 10 tags");
        }
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(["store", "storeFromUrl"])(
    "writes tags after %s becomes ready",
    async (method) => {
      const { t, azure, file } = setup();
      stubBlob({});
      stubTags({ defender: "keep" });
      const common = {
        contentType: "image/png",
        uploadedBy: "u1",
        tags: { project: "new" },
      };
      const result = await t.action((ctx) =>
        method === "store"
          ? azure.store(ctx, { ...common, data: PNG })
          : azure.storeFromUrl(ctx, {
              ...common,
              sourceUrl: "https://example.com/image.png",
            }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(await file(result.fileId)).toMatchObject({
        status: "ready",
        tags: common.tags,
      });
      expect(writes()).toHaveLength(1);
      expect(writes()[0]![1]?.body).toContain("<Key>defender</Key>");
    },
  );

  it("writes tags on the base blob after block snapshot confirmation", async () => {
    const { t, azure, file } = setup({ blockUploads: true });
    const ticket = await reserveTags(t, azure, { project: "blocks" });
    stubBlocks();
    stubTags();
    expect(
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId)),
    ).toMatchObject({ ok: true });
    expect(await file(ticket.fileId)).toMatchObject({
      status: "ready",
      snapshot: expect.any(String),
    });
    expect(writes()).toHaveLength(1);
    expect(params(String(writes()[0]![0])).has("snapshot")).toBe(false);
    expect(Object.keys(ticket.headers).some((key) => key.includes("tag"))).toBe(
      false,
    );
  });

  it.each([204, 503])(
    "writes only after clean malware verdict and retains ready on tag status %s",
    async (status) => {
      const { t, azure, file } = setup({ requireMalwareScan: true });
      const ticket = await reserveTags(t, azure, { project: "scanned" });
      stubBlob({});
      await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId));
      expect(await file(ticket.fileId)).toMatchObject({ status: "scanning" });
      expect(writes()).toHaveLength(0);
      stubTags({ "Malware scanning scan result": "No threats found" }, status);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await t.action((ctx) => azure.scanMalware(ctx))).toBe(1);
        expect(await file(ticket.fileId)).toMatchObject({ status: "ready" });
        expect(writes()).toHaveLength(1);
        expect(writes()[0]![1]?.body).toContain(
          "<Key>Malware scanning scan result</Key><Value>No threats found</Value>",
        );
        expect(log.mock.calls.length).toBe(status === 503 ? 1 : 0);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("writes tags through Event Grid confirmation and ignores redelivery", async () => {
    const router = httpRouter();
    const t = convexTest(defineSchema({}), {
      ...componentTest.modules,
      "./component/http.ts": async () => ({ default: router }),
    });
    const azure = new AzureBlob(register(t), {
      config: {
        ...config,
        endpoint: "https://127.0.0.1:10000/devstoreaccount1",
      },
      now: () => T0,
    });
    const ticket = await reserveTags(t, azure, { project: "event" });
    const doc = (await t.query((ctx) => azure.getFile(ctx, ticket.fileId)))!;
    const secret = "a".repeat(32);
    router.route({
      path: "/events",
      method: "POST",
      handler: azure.eventGridHandler({ secret }),
    });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          id: "tag-event",
          eventType: "Microsoft.Storage.BlobCreated",
          subject: `/blobServices/default/containers/uploads/blobs/${doc.blobName}`,
          eventTime: new Date(T0).toISOString(),
          dataVersion: "",
          metadataVersion: "1",
          data: {
            url: `https://127.0.0.1:10000/devstoreaccount1/uploads/${doc.blobName}`,
          },
        },
      ]),
    };
    stubBlob({});
    stubTags();
    expect((await t.fetch(`/events?secret=${secret}`, request)).status).toBe(
      200,
    );
    expect(writes()).toHaveLength(1);
    fetchMock.mockClear();
    expect((await t.fetch(`/events?secret=${secret}`, request)).status).toBe(
      200,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("encryption scope", () => {
  const scope = "customer-a";

  it.each([
    "ab",
    "a".repeat(64),
    "Customer",
    "-abc",
    "abc-",
    "a--b",
    "a_b",
    "a b",
    "",
  ])("rejects the invalid scope name %j", (encryptionScope) => {
    expect(() => new AzureBlob({} as never, { encryptionScope })).toThrow(
      "Invalid encryptionScope",
    );
  });

  it.each(["abc", "customer-a", "a".repeat(63), "a1-b2-c3"])(
    "accepts the scope name %j",
    (encryptionScope) => {
      expect(
        () => new AzureBlob({} as never, { encryptionScope }),
      ).not.toThrow();
    },
  );

  it("signs the browser upload ticket with ses and leaves read and delete URLs unscoped", async () => {
    const { t, azure } = setup({ encryptionScope: scope });
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(ticket.uploadUrl).get("ses")).toBe(scope);
    expect(params(ticket.uploadUrl).get("sp")).toBe("c");
    expect(ticket.headers).not.toHaveProperty("x-ms-encryption-scope");

    stubBlob({ length: PNG.length });
    expect(
      (await t.action((ctx) => azure.confirmUpload(ctx, ticket.fileId))).ok,
    ).toBe(true);
    for (const [url] of fetchMock.mock.calls)
      expect(params(String(url)).has("ses")).toBe(false);

    const readUrl = await t.query((ctx) => azure.getUrl(ctx, ticket.fileId));
    expect(params(readUrl).get("sp")).toBe("r");
    expect(params(readUrl).has("ses")).toBe(false);

    fetchMock.mockClear();
    await t.action((ctx) => azure.purge(ctx, ticket.fileId));
    expect(methods()).toEqual(["DELETE"]);
    expect(params(String(fetchMock.mock.calls[0]?.[0])).has("ses")).toBe(false);
  });

  it("does not sign ses without the option", async () => {
    const { t, azure } = setup();
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(ticket.uploadUrl).has("ses")).toBe(false);
  });

  it("signs block staging and the server-side commit with ses but not the snapshot or reads", async () => {
    const state = setup({ blockUploads: true, encryptionScope: scope });
    const ticket = await state.t.action((ctx) =>
      state.azure.generateUploadUrl(ctx, {
        uploadedBy: "u1",
        contentType: "image/png",
        size: PNG.length,
      }),
    );
    expect(ticket.kind).toBe("blocks");
    expect(params(ticket.uploadUrl).get("sp")).toBe("w");
    expect(params(ticket.uploadUrl).get("ses")).toBe(scope);

    stubBlocks();
    expect(
      (
        await state.t.action((ctx) =>
          state.azure.confirmUpload(ctx, ticket.fileId),
        )
      ).ok,
    ).toBe(true);
    const seen = fetchMock.mock.calls.map(([url, init]) => ({
      method: init?.method ?? "GET",
      comp: params(String(url)).get("comp"),
      ses: params(String(url)).get("ses"),
    }));
    expect(seen).toEqual([
      { method: "GET", comp: "blocklist", ses: null },
      { method: "HEAD", comp: null, ses: null },
      { method: "PUT", comp: "blocklist", ses: scope },
      { method: "PUT", comp: "snapshot", ses: null },
      { method: "HEAD", comp: null, ses: null },
      { method: "GET", comp: null, ses: null },
    ]);
  });

  it("signs the server-side store PUT with ses", async () => {
    const { t, azure } = setup({ encryptionScope: scope });
    stubBlob({ length: PNG.length });
    const result = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(result.ok).toBe(true);
    expect(methods()).toEqual(["PUT", "HEAD", "GET"]);
    expect(params(String(fetchMock.mock.calls[0]?.[0])).get("ses")).toBe(scope);
    for (const [url] of fetchMock.mock.calls.slice(1))
      expect(params(String(url)).has("ses")).toBe(false);
  });

  it("signs the storeFromUrl destination with ses", async () => {
    const { t, azure } = setup({ encryptionScope: scope });
    stubBlob({ length: PNG.length });
    const result = await t.action((ctx) =>
      azure.storeFromUrl(ctx, {
        sourceUrl: "https://source.example/image.png",
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(params(String(url)).get("ses")).toBe(scope);
    expect(init?.headers).toMatchObject({
      "x-ms-copy-source": "https://source.example/image.png",
    });
  });

  it("signs user-delegation upload tickets with ses", async () => {
    const { t, azure } = setup({ config: entraConfig, encryptionScope: scope });
    stubEntra({ length: PNG.length });
    await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
    const ticket = await t.action((ctx) =>
      azure.generateUploadUrl(ctx, {
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(params(ticket.uploadUrl).get("skoid")).toBeTruthy();
    expect(params(ticket.uploadUrl).get("ses")).toBe(scope);
  });
  it("sends the scope as a header on bearer-token writes only", async () => {
    const { t, azure } = setup({ config: entraConfig, encryptionScope: scope });
    stubEntra({ length: PNG.length });
    const result = await t.action((ctx) =>
      azure.store(ctx, {
        data: PNG,
        contentType: "image/png",
        uploadedBy: "u1",
      }),
    );
    expect(result.ok).toBe(true);
    const blobCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes("/oauth2/v2.0/token"),
    );
    expect(blobCalls[0]?.[1]?.headers).toMatchObject({
      "x-ms-encryption-scope": scope,
    });
    for (const [url, init] of blobCalls) {
      expect(params(String(url)).has("ses")).toBe(false);
      if (init !== blobCalls[0]?.[1])
        expect(init?.headers).not.toHaveProperty("x-ms-encryption-scope");
    }
  });
});
