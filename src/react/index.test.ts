import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadError,
  uploadToAzure,
  uploadBlocksToAzure,
  useUploadFile,
  type UploadApi,
} from "./index.js";

const { generateUploadUrl, confirmUpload, renewUploadUrl } = vi.hoisted(() => ({
  generateUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  renewUploadUrl: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: (reference: unknown) =>
    reference === "renew" ? renewUploadUrl : generateUploadUrl,
  useAction: () => confirmUpload,
}));

class FakeXhr {
  static last: FakeXhr | null = null;
  static respondWith: number | "error" = 201;
  static automatic = true;
  static requests: FakeXhr[] = [];
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
    FakeXhr.requests.push(this);
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
  FakeXhr.requests = [];
  generateUploadUrl.mockReset();
  confirmUpload.mockReset();
  renewUploadUrl.mockReset();
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
    await act(async () => {
      hook.cancel();
    });
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

  it("pauses blocks, renews the same ticket, and resumes without resending successful blocks", async () => {
    api.renewUploadUrl = "renew" as unknown as NonNullable<
      typeof api.renewUploadUrl
    >;
    FakeXhr.automatic = false;
    const blockFile = new Blob(["abcdefgh"], { type: "image/png" });
    const ticket = {
      fileId: "f1",
      uploadUrl: "https://x/y?sig=old",
      headers: {},
      kind: "blocks",
      blockSize: 2,
    };
    generateUploadUrl.mockResolvedValue(ticket);
    renewUploadUrl.mockResolvedValue({
      ...ticket,
      uploadUrl: "https://x/y?sig=new",
    });
    confirmUpload.mockResolvedValue({
      ok: true,
      size: 8,
      contentType: "image/png",
    });
    await mount();
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.upload(blockFile).catch((caught: unknown) => caught);
    });
    expect(FakeXhr.requests).toHaveLength(3);
    await act(async () => {
      FakeXhr.requests[0]!.status = 201;
      FakeXhr.requests[0]!.onload?.();
    });
    const firstId = new URL(FakeXhr.requests[0]!.url).searchParams.get(
      "blockid",
    );
    await act(async () => {
      hook.pause();
      expect(await result).toMatchObject({ name: "AbortError" });
    });
    expect(hook.canResume).toBe(true);
    expect(hook.isUploading).toBe(false);
    const prior = FakeXhr.requests.length;
    FakeXhr.automatic = true;
    await act(async () => {
      expect(await hook.resume()).toBe("f1");
    });
    expect(renewUploadUrl).toHaveBeenCalledWith({ fileId: "f1" });
    expect(FakeXhr.requests.slice(prior)).toHaveLength(3);
    expect(
      FakeXhr.requests
        .slice(prior)
        .some(
          (xhr) => new URL(xhr.url).searchParams.get("blockid") === firstId,
        ),
    ).toBe(false);
    expect(
      FakeXhr.requests
        .slice(prior)
        .every((xhr) => new URL(xhr.url).searchParams.get("sig") === "new"),
    ).toBe(true);
    expect(generateUploadUrl).toHaveBeenCalledTimes(1);
    expect(hook.canResume).toBe(false);
    delete api.renewUploadUrl;
  });

  it("retains staged blocks after failed confirmation and cancellation destroys the session", async () => {
    generateUploadUrl.mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: {},
      kind: "blocks",
      blockSize: 2,
    });
    confirmUpload.mockRejectedValueOnce(new Error("Connection lost"));
    confirmUpload.mockResolvedValue({
      ok: true,
      size: 3,
      contentType: "image/png",
    });
    await mount();
    await act(async () => {
      await expect(hook.upload(file)).rejects.toThrow("Connection lost");
    });
    expect(hook.canResume).toBe(true);
    const count = FakeXhr.requests.length;
    await act(async () => {
      expect(await hook.resume()).toBe("f1");
    });
    expect(FakeXhr.requests).toHaveLength(count);
    confirmUpload.mockResolvedValue({ ok: false, reason: "Temporary refusal" });
    await act(async () => {
      await expect(hook.upload(file)).rejects.toThrow("Temporary refusal");
      hook.cancel();
    });
    expect(hook.canResume).toBe(false);
    await expect(hook.resume()).rejects.toThrow("No paused upload");
  });

  it("can pause while obtaining a block ticket, and resumes a lost confirmation response without renewal", async () => {
    api.renewUploadUrl = "renew" as unknown as NonNullable<
      typeof api.renewUploadUrl
    >;
    let issue!: (ticket: object) => void;
    generateUploadUrl.mockReturnValue(
      new Promise((resolve) => {
        issue = resolve;
      }),
    );
    confirmUpload.mockRejectedValueOnce(new Error("Response lost"));
    confirmUpload.mockResolvedValue({
      ok: true,
      size: file.size,
      contentType: file.type,
    });
    await mount();
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.upload(file).catch((caught: unknown) => caught);
      hook.pause();
    });
    await act(async () => {
      issue({
        fileId: "f1",
        uploadUrl: "https://x/y",
        headers: {},
        kind: "blocks",
        blockSize: 2,
      });
      expect(await result).toMatchObject({ name: "AbortError" });
    });
    expect(hook.canResume).toBe(true);
    expect(FakeXhr.requests).toHaveLength(0);
    renewUploadUrl.mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: {},
      kind: "blocks",
      blockSize: 2,
    });
    await act(async () => {
      await expect(hook.resume()).rejects.toThrow("Response lost");
    });
    const requests = FakeXhr.requests.length;
    renewUploadUrl.mockClear();
    await act(async () => {
      expect(await hook.resume()).toBe("f1");
    });
    expect(FakeXhr.requests).toHaveLength(requests);
    expect(renewUploadUrl).not.toHaveBeenCalled();
    delete api.renewUploadUrl;
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

  describe("uploadBlocksToAzure", () => {
    const ticket = {
      fileId: "f1",
      uploadUrl: "https://x/y",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "image/png" },
      kind: "blocks" as const,
      blockSize: 2,
    };
    const file = new Blob(["abcdefgh"]);

    it("slices with three workers and reports actual successful and in-flight bytes", async () => {
      FakeXhr.automatic = false;
      const progress: number[] = [];
      const staged = new Set<string>();
      const result = uploadBlocksToAzure(ticket, file, {
        onProgress: (value) => progress.push(value),
        stagedBlockIds: staged,
      });
      expect(FakeXhr.requests).toHaveLength(3);
      expect(
        FakeXhr.requests.every((xhr) => !("x-ms-blob-type" in xhr.headers)),
      ).toBe(true);
      const first = FakeXhr.requests[0]!;
      expect((first.body as Blob).size).toBe(2);
      first.upload.onprogress?.({
        loaded: 1,
        total: 999,
        lengthComputable: true,
      } as ProgressEvent);
      expect(progress.at(-1)).toBe(1 / 8);
      first.status = 201;
      first.onload?.();
      await Promise.resolve();
      expect(staged.size).toBe(1);
      expect(progress.at(-1)).toBe(2 / 8);
      for (const xhr of FakeXhr.requests.slice(1)) {
        xhr.status = 201;
        xhr.onload?.();
      }
      await result;
      expect(staged.size).toBe(4);
      expect(progress.at(-1)).toBe(1);
      expect(
        FakeXhr.requests.every(
          (xhr) => new URL(xhr.url).searchParams.get("comp") === "block",
        ),
      ).toBe(true);
    });

    it("aborts siblings and ignores stale events after a failed worker before returning", async () => {
      FakeXhr.automatic = false;
      const aborts: number[] = [];
      const progress: number[] = [];
      const staged = new Set<string>();
      const result = uploadBlocksToAzure(ticket, file, {
        stagedBlockIds: staged,
        onProgress: (value) => progress.push(value),
      }).catch((caught: unknown) => caught);
      for (const [index, xhr] of FakeXhr.requests.entries()) {
        const onabort = xhr.onabort;
        xhr.onabort = () => {
          aborts.push(index);
          onabort?.();
        };
      }
      FakeXhr.requests[0]!.status = 403;
      FakeXhr.requests[0]!.onload?.();
      expect(await result).toMatchObject({ status: 403 });
      expect(aborts).toEqual([1, 2]);
      const prior = progress.length;
      for (const xhr of FakeXhr.requests) {
        xhr.upload.onprogress?.({ loaded: 2 } as ProgressEvent);
        xhr.status = 201;
        xhr.onload?.();
      }
      expect(progress).toHaveLength(prior);
      expect(staged.size).toBe(0);
      expect(FakeXhr.requests).toHaveLength(3);
    });
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
