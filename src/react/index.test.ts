import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadError, uploadToAzure } from "./index.js";

class FakeXhr {
  static last: FakeXhr | null = null;
  static respondWith: number | "error" = 201;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: 1,
        total: 2,
      } as ProgressEvent);
      if (FakeXhr.respondWith === "error") return this.onerror?.();
      this.status = FakeXhr.respondWith;
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

beforeEach(() => {
  FakeXhr.respondWith = 201;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadToAzure", () => {
  const file = new Blob(["abc"], { type: "image/png" });

  it("PUTs the file as a block blob with the ticket headers and reports progress", async () => {
    const progress: number[] = [];
    await uploadToAzure(
      "https://acct.blob.core.windows.net/c/b.png?sig=x",
      file,
      {
        headers: { "content-type": "image/png" },
        onProgress: (fraction) => progress.push(fraction),
      },
    );
    const xhr = FakeXhr.last;
    expect(xhr?.method).toBe("PUT");
    expect(xhr?.headers).toEqual({
      "x-ms-blob-type": "BlockBlob",
      "content-type": "image/png",
    });
    expect(xhr?.body).toBe(file);
    expect(progress).toEqual([0.5, 1]);
  });

  it("rejects with the status when Azure refuses the upload", async () => {
    FakeXhr.respondWith = 403;
    const error = await uploadToAzure("https://x/y", file).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ status: 403 });
  });

  it("explains network failures, which are usually a missing CORS rule", async () => {
    FakeXhr.respondWith = "error";
    await expect(uploadToAzure("https://x/y", file)).rejects.toThrow("CORS");
  });

  it("aborts through the signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadToAzure("https://x/y", file, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});
