import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadError,
  uploadToAzure,
  useUploadFile,
  type UploadApi,
} from "./index.js";

const { generateUploadUrl, confirmUpload } = vi.hoisted(() => ({
  generateUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: () => generateUploadUrl,
  useAction: () => confirmUpload,
}));

class FakeXhr {
  static last: FakeXhr | null = null;
  static respondWith: number | "error" = 201;
  static automatic = true;
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
    if (!FakeXhr.automatic) return;
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
  FakeXhr.automatic = true;
  FakeXhr.last = null;
  generateUploadUrl.mockReset();
  confirmUpload.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

describe("useUploadFile", () => {
  const api = {} as UploadApi<{
    contentType: string;
    fileName?: string;
    size?: number;
  }>;
  const file = new Blob(["abc"], { type: "image/png" });
  let renderer: ReactTestRenderer | undefined;
  let hook: ReturnType<typeof useUploadFile>;

  async function mount() {
    function Harness() {
      hook = useUploadFile(api);
      return null;
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(createElement(Harness));
    });
  }

  afterEach(async () => {
    if (renderer)
      await act(async () => {
        renderer?.unmount();
      });
    renderer = undefined;
  });

  it("confirms a completed upload and clears the uploading state", async () => {
    generateUploadUrl.mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: {},
    });
    confirmUpload.mockResolvedValue({
      ok: true,
      size: 3,
      contentType: "image/png",
    });
    await mount();
    await act(async () => {
      expect(await hook.upload(file)).toBe("f1");
    });
    expect(confirmUpload).toHaveBeenCalledWith({ fileId: "f1" });
    expect(hook.isUploading).toBe(false);
    expect(hook.error).toBeNull();
  });

  it("cancels while waiting for a ticket without starting the PUT", async () => {
    let ticket!: (value: {
      fileId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }) => void;
    generateUploadUrl.mockReturnValue(
      new Promise((resolve) => {
        ticket = resolve;
      }),
    );
    await mount();
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.upload(file).catch((error: unknown) => error);
    });
    hook.cancel();
    await act(async () => {
      ticket({ fileId: "f1", uploadUrl: "https://x/y", headers: {} });
      expect(await result).toMatchObject({ name: "AbortError" });
    });
    expect(FakeXhr.last).toBeNull();
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(hook.isUploading).toBe(false);
  });

  it("does not leak an earlier upload's cancellation into a newer upload", async () => {
    FakeXhr.automatic = false;
    generateUploadUrl.mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: {},
    });
    confirmUpload.mockResolvedValue({
      ok: true,
      size: 3,
      contentType: "image/png",
    });
    await mount();
    let first!: Promise<unknown>;
    await act(async () => {
      first = hook.upload(file).catch((error: unknown) => error);
    });
    const old = FakeXhr.last!;
    let second!: Promise<string>;
    await act(async () => {
      second = hook.upload(file);
    });
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(hook.error).toBeNull();
    expect(hook.isUploading).toBe(true);
    await act(async () => {
      old.upload.onprogress?.({
        lengthComputable: true,
        loaded: 9,
        total: 10,
      } as ProgressEvent);
    });
    expect(hook.progress).toBe(0);
    await act(async () => {
      FakeXhr.last!.status = 201;
      FakeXhr.last!.onload?.();
      expect(await second).toBe("f1");
    });
    expect(hook.error).toBeNull();
    expect(hook.isUploading).toBe(false);
  });

  it("aborts the active PUT on unmount without confirming it", async () => {
    FakeXhr.automatic = false;
    generateUploadUrl.mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: {},
    });
    await mount();
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.upload(file).catch((error: unknown) => error);
    });
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(confirmUpload).not.toHaveBeenCalled();
  });
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
