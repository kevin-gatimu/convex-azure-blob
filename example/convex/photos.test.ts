/// <reference types="vite/client" />
import azureBlobTest from "convex-azure-blob/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// How an app tests code that uses the component: register it, set the env, stub Azure.
function initConvexTest() {
  const t = convexTest(schema, modules);
  azureBlobTest.register(t);
  return t;
}

const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
  switch (init?.method ?? "GET") {
    case "HEAD":
      return new Response(null, {
        headers: { "content-length": "8", "content-type": "image/png" },
      });
    case "GET":
      return new Response(PNG, { status: 206 });
    default:
      return new Response(null, { status: 202 });
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AZURE_BLOB_ACCOUNT", "devstoreaccount1");
  vi.stubEnv("AZURE_BLOB_KEY", btoa("test-key"));
  vi.stubEnv("AZURE_BLOB_CONTAINER", "uploads");
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
      /^https:\/\/devstoreaccount1\.blob\.core\.windows\.net\/uploads\/photos\/.+\.png\?.*sp=c/,
    );

    // The browser would PUT the bytes here; the stubbed HEAD and GET stand in for them.
    expect(
      await t.action(api.photos.confirmUpload, { fileId: ticket.fileId }),
    ).toMatchObject({
      ok: true,
    });

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
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  test("only the owner can delete a photo", async () => {
    const t = initConvexTest();
    const alice = t.withIdentity({ subject: "alice" });
    const { fileId } = await alice.mutation(api.photos.generateUploadUrl, {
      contentType: "image/png",
    });
    await alice.action(api.photos.confirmUpload, { fileId });
    const [photo] = await alice.query(api.photos.list, {});
    await expect(
      t
        .withIdentity({ subject: "mallory" })
        .mutation(api.photos.remove, { id: photo!.id }),
    ).rejects.toThrow("Photo not found");
  });
});
