import { createElement } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../upload-policy";
import App from "./App";

type HookState = { progress: number | null; canResume: boolean };
type Fake = {
  setState: (state: HookState) => void;
  settle: { resolve: (id: string) => void; reject: (e: Error) => void } | null;
  upload: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

const h = vi.hoisted(() => {
  const fakes: Fake[] = [];
  const createFake = (): Fake => {
    const fake = {
      setState: () => {},
      settle: null,
      upload: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
    } as Fake;
    const pending = () =>
      new Promise<string>((resolve, reject) => {
        fake.settle = { resolve, reject };
      });
    fake.upload.mockImplementation(pending);
    fake.resume.mockImplementation(pending);
    return fake;
  };
  return {
    fakes,
    createFake,
    connected: true,
    files: [] as unknown[] | undefined,
    remove: vi.fn(),
  };
});

// One fake hook instance per UploadRow, kept across renders like the real hook's state.
vi.mock("convex-azure-blob/react", async () => {
  const { useRef, useState } =
    await vi.importActual<typeof import("react")>("react");
  return {
    useUploadFile: () => {
      const [state, setState] = useState<HookState>({
        progress: null,
        canResume: false,
      });
      const ref = useRef<Fake | null>(null);
      if (!ref.current) {
        ref.current = h.createFake();
        h.fakes.push(ref.current);
      }
      const fake = ref.current;
      fake.setState = setState;
      return {
        upload: fake.upload,
        resume: fake.resume,
        pause: fake.pause,
        cancel: fake.cancel,
        progress: state.progress,
        canResume: state.canResume,
        isUploading: state.progress !== null,
        error: null,
      };
    },
  };
});
vi.mock("convex/react", () => ({
  useQuery: () => h.files,
  useMutation: () => h.remove,
  useConvexConnectionState: () => ({ isWebSocketConnected: h.connected }),
}));

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

const png = (name: string, type = "image/png", size = 3) =>
  new File(["x".repeat(size)], name, { type });
const photo = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  fileId: "f1",
  fileName: "cat.png",
  size: 2048,
  contentType: "image/png",
  url: "https://blob.test/cat.png?sp=r",
  downloadUrl: "https://blob.test/cat.png?rscd=x",
  ...over,
});

describe("App", () => {
  let renderer: ReactTestRenderer;
  const root = () => renderer.root;
  const rows = () =>
    root().findAll(
      (n) =>
        n.type === "li" && String(n.props.className).startsWith("queue-row"),
    );
  const row = (name: string) => {
    const found = rows().find((r) => textOf(r).includes(name));
    if (!found) throw new Error(`No row for ${name}`);
    return found;
  };
  const button = (scope: ReactTestInstance, label: string) =>
    scope.findAllByType("button").find((b) => textOf(b) === label);
  const alerts = () =>
    root()
      .findAll((n) => n.type === "p" && n.props.role === "alert")
      .map(textOf);
  const click = async (b: ReactTestInstance | undefined) => {
    if (!b) throw new Error("Button not found");
    await act(async () => {
      b.props.onClick();
    });
  };
  const mount = async () => {
    await act(async () => {
      renderer = create(createElement(App));
    });
  };
  const choose = async (label: string, files: unknown) => {
    const target = { files, value: "C:\\fakepath\\picked" };
    await act(async () => {
      root().findByProps({ "aria-label": label }).props.onChange({ target });
    });
    return target;
  };
  const setProgress = (i: number, progress: number | null, canResume = false) =>
    act(async () => {
      h.fakes[i]!.setState({ progress, canResume });
    });
  const resolveUpload = (i: number) =>
    act(async () => {
      h.fakes[i]!.setState({ progress: null, canResume: false });
      h.fakes[i]!.settle!.resolve("file");
    });
  const rejectUpload = (i: number, error: Error, canResume = false) =>
    act(async () => {
      h.fakes[i]!.setState({ progress: null, canResume });
      h.fakes[i]!.settle!.reject(error);
    });
  const abort = () => new DOMException("Upload aborted", "AbortError") as Error;

  beforeEach(() => {
    h.fakes.length = 0;
    h.connected = true;
    h.files = [];
    h.remove.mockReset();
    h.remove.mockResolvedValue(null);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    await act(async () => {
      renderer.unmount();
    });
    vi.unstubAllGlobals();
  });

  describe("selection", () => {
    it("queues one chosen file and resets the input value", async () => {
      await mount();
      const target = await choose("Choose one file", [png("cat.png")]);
      expect(target.value).toBe("");
      expect(rows()).toHaveLength(1);
      expect(textOf(row("cat.png"))).toContain("queued");
      expect(button(root(), "Upload file")).toBeDefined();
    });

    it("queues several files and appends later selections", async () => {
      await mount();
      await choose("Choose multiple files", [png("a.png"), png("b.png")]);
      expect(rows()).toHaveLength(2);
      expect(button(root(), "Upload 2 files")).toBeDefined();
      await choose("Choose one file", [png("c.png")]);
      expect(rows()).toHaveLength(3);
    });

    it("accepts a file with no MIME type by its extension", async () => {
      await mount();
      await choose("Choose one file", [png("doc.pdf", "")]);
      expect(rows()).toHaveLength(1);
    });

    it("ignores an empty selection", async () => {
      await mount();
      await choose("Choose one file", null);
      expect(rows()).toHaveLength(0);
      expect(alerts()).toEqual([]);
    });

    it("rejects unsupported, empty and oversize files but keeps the valid ones", async () => {
      await mount();
      const huge = png("huge.mp4", "video/mp4");
      Object.defineProperty(huge, "size", { value: MAX_FILE_BYTES + 1 });
      await choose("Choose multiple files", [
        png("notes.txt", "text/plain"),
        png("empty.pdf", "application/pdf", 0),
        huge,
        png("ok.png"),
      ]);
      expect(rows()).toHaveLength(1);
      expect(textOf(row("ok.png"))).toContain("queued");
      expect(alerts()).toEqual([
        "notes.txt: this file type is not supported.",
        "empty.pdf: empty files cannot be uploaded.",
        "huge.mp4: exceeds Azure's 190.7 TiB block-blob limit.",
      ]);
    });
  });

  describe("batch", () => {
    it("uploads sequentially and shows verified totals", async () => {
      await mount();
      const [a, b] = [png("a.png"), png("b.png")];
      await choose("Choose multiple files", [a, b]);
      await click(button(root(), "Upload 2 files"));
      expect(h.fakes[0]!.upload).toHaveBeenCalledWith(a);
      expect(h.fakes[1]!.upload).not.toHaveBeenCalled();
      await resolveUpload(0);
      expect(h.fakes[1]!.upload).toHaveBeenCalledWith(b);
      await resolveUpload(1);
      expect(textOf(row("a.png"))).toContain("Uploaded and verified");
      expect(textOf(row("b.png"))).toContain("Uploaded and verified");
      expect(textOf(root())).toContain("2/2 verified");
      expect(button(root(), "No files queued")!.props.disabled).toBe(true);
    });

    it("ignores a second click while a batch runs and disables the inputs", async () => {
      await mount();
      await choose("Choose multiple files", [png("a.png"), png("b.png")]);
      const start = button(root(), "Upload 2 files");
      await act(async () => {
        start!.props.onClick();
        start!.props.onClick();
      });
      expect(h.fakes[0]!.upload).toHaveBeenCalledTimes(1);
      expect(
        root().findByProps({ "aria-label": "Choose one file" }).props.disabled,
      ).toBe(true);
    });

    it("keeps the rest of the batch when one file fails", async () => {
      await mount();
      await choose("Choose multiple files", [png("a.png"), png("b.png")]);
      await click(button(root(), "Upload 2 files"));
      await rejectUpload(0, new Error("network down"));
      expect(row("a.png").props.className).toContain("failed");
      expect(alerts()[0]).toContain("network down");
      expect(alerts()[0]).toContain("CORS");
      expect(button(row("a.png"), "Retry")).toBeDefined();
      expect(h.fakes[1]!.upload).toHaveBeenCalled();
      await resolveUpload(1);
      expect(textOf(row("b.png"))).toContain("Uploaded and verified");
      expect(rows()).toHaveLength(2);
    });

    it("never uploads a queued file that was cancelled", async () => {
      await mount();
      await choose("Choose multiple files", [
        png("a.png"),
        png("b.png"),
        png("c.png"),
      ]);
      await click(button(root(), "Upload 3 files"));
      await click(button(row("b.png"), "Cancel"));
      expect(h.fakes[1]!.cancel).toHaveBeenCalled();
      expect(row("b.png").props.className).toContain("cancelled");
      await resolveUpload(0);
      expect(h.fakes[1]!.upload).not.toHaveBeenCalled();
      expect(h.fakes[2]!.upload).toHaveBeenCalled();
    });

    it("cancelling the active file moves on without an error", async () => {
      await mount();
      await choose("Choose multiple files", [png("a.png"), png("b.png")]);
      await click(button(root(), "Upload 2 files"));
      await click(button(row("a.png"), "Cancel"));
      await rejectUpload(0, abort());
      expect(row("a.png").props.className).toContain("cancelled");
      expect(alerts()).toEqual([]);
      expect(h.fakes[1]!.upload).toHaveBeenCalled();
    });
  });

  describe("row controls", () => {
    const startOne = async () => {
      await mount();
      await choose("Choose one file", [png("a.png")]);
      await click(button(root(), "Upload file"));
    };

    it("pauses, then resumes the same hook instance without a new upload", async () => {
      await startOne();
      await setProgress(0, 0.5);
      await click(button(row("a.png"), "Pause"));
      expect(h.fakes[0]!.pause).toHaveBeenCalled();
      await rejectUpload(0, abort(), true);
      expect(row("a.png").props.className).toContain("paused");
      expect(alerts()).toEqual([]);
      await click(button(row("a.png"), "Resume"));
      expect(h.fakes).toHaveLength(1);
      expect(h.fakes[0]!.resume).toHaveBeenCalledTimes(1);
      expect(h.fakes[0]!.upload).toHaveBeenCalledTimes(1);
      await resolveUpload(0);
      expect(textOf(row("a.png"))).toContain("Uploaded and verified");
    });

    it("resumes once when Resume is clicked twice", async () => {
      await startOne();
      await rejectUpload(0, abort(), true);
      const resume = button(row("a.png"), "Resume")!;
      await act(async () => {
        resume.props.onClick();
        resume.props.onClick();
      });
      expect(h.fakes[0]!.resume).toHaveBeenCalledTimes(1);
    });

    it("offers Retry, not Resume, for a paused upload that cannot resume", async () => {
      await startOne();
      await rejectUpload(0, abort(), false);
      h.fakes[0]!.upload.mockClear();
      expect(button(row("a.png"), "Resume")).toBeUndefined();
      await click(button(row("a.png"), "Retry"));
      expect(h.fakes[0]!.upload).toHaveBeenCalledTimes(1);
    });

    it("shows percentage progress with a Pause button", async () => {
      await startOne();
      await setProgress(0, 0.5);
      const bar = row("a.png").findByType("progress");
      expect(bar.props.value).toBe(0.5);
      expect(textOf(row("a.png"))).toContain("50% uploaded");
      expect(button(row("a.png"), "Pause")).toBeDefined();
    });

    it("shows the verifying state, without Pause, once all bytes are sent", async () => {
      await startOne();
      await setProgress(0, 1);
      expect(textOf(row("a.png"))).toContain("Verifying with Convex...");
      expect(button(row("a.png"), "Pause")).toBeUndefined();
    });

    it("hides Resume on a completed row even if the hook says it can resume", async () => {
      await startOne();
      await resolveUpload(0);
      await setProgress(0, null, true);
      expect(button(row("a.png"), "Resume")).toBeUndefined();
    });
  });

  describe("connection", () => {
    it("shows no banner while connected", async () => {
      await mount();
      expect(textOf(root())).toContain("Convex connected");
      expect(alerts()).toEqual([]);
    });

    it("warns and disables upload and delete while disconnected", async () => {
      h.connected = false;
      h.files = [photo()];
      await mount();
      expect(textOf(root())).toContain("Convex reconnecting");
      expect(alerts().some((m) => m.includes("Uploads are unavailable"))).toBe(
        true,
      );
      await choose("Choose one file", [png("a.png")]);
      expect(button(root(), "Upload file")!.props.disabled).toBe(true);
      expect(button(root(), "Delete")!.props.disabled).toBe(true);
    });

    it("disables Resume when the connection drops mid-pause", async () => {
      await mount();
      await choose("Choose one file", [png("a.png")]);
      await click(button(root(), "Upload file"));
      await rejectUpload(0, abort(), true);
      h.connected = false;
      await act(async () => {
        renderer.update(createElement(App));
      });
      expect(button(row("a.png"), "Resume")!.props.disabled).toBe(true);
    });
  });

  describe("library", () => {
    it("shows loading, or a backend hint when disconnected", async () => {
      h.files = undefined;
      await mount();
      expect(textOf(root())).toContain("Loading your library...");
      h.connected = false;
      await act(async () => {
        renderer.update(createElement(App));
      });
      expect(textOf(root())).toContain("Waiting for the Convex backend");
    });

    it("shows an empty state", async () => {
      await mount();
      expect(textOf(root())).toContain("A clean slate for your next upload.");
    });

    it("renders images as previews and PDF/media as download cards", async () => {
      h.files = [
        photo(),
        photo({
          id: "p2",
          fileName: "spec.pdf",
          contentType: "application/pdf",
          url: "https://blob.test/spec.pdf",
          downloadUrl: "https://blob.test/spec.pdf?rscd=x",
        }),
        photo({
          id: "p3",
          fileName: "clip.mp4",
          contentType: "video/mp4",
          url: "https://blob.test/clip.mp4",
          downloadUrl: null,
        }),
      ];
      await mount();
      const images = root().findAllByType("img");
      expect(images).toHaveLength(1);
      expect(images[0]!.props.src).toBe("https://blob.test/cat.png?sp=r");
      const text = textOf(root());
      expect(text).toContain("PDF");
      expect(text).toContain("application/pdf");
      expect(text).toContain("video/mp4");
      const links = root()
        .findAllByType("a")
        .filter((a) => textOf(a) === "Download file");
      expect(links.map((a) => a.props.href)).toEqual([
        "https://blob.test/cat.png?rscd=x",
        "https://blob.test/spec.pdf?rscd=x",
      ]);
      const viewLinks = root()
        .findAllByType("a")
        .filter((a) => textOf(a) === "View file");
      expect(viewLinks.map((a) => a.props.href)).toEqual([
        "https://blob.test/cat.png?sp=r",
        "https://blob.test/spec.pdf",
        "https://blob.test/clip.mp4",
      ]);
      for (const link of viewLinks) {
        expect(link.props.target).toBe("_blank");
        expect(link.props.rel).toBe("noopener noreferrer");
      }
      expect(text).toContain("Download unavailable");
    });

    it("does not offer a view link when the read URL is unavailable", async () => {
      h.files = [photo({ url: null, downloadUrl: null })];
      await mount();
      expect(
        root()
          .findAllByType("a")
          .filter((a) => textOf(a) === "View file"),
      ).toHaveLength(0);
    });

    it("falls back to a card when an image fails to load", async () => {
      h.files = [photo()];
      await mount();
      await act(async () => {
        root().findByType("img").props.onError();
      });
      expect(root().findAllByType("img")).toHaveLength(0);
      expect(textOf(root())).toContain("Preview unavailable");
    });

    it("deletes a file by id", async () => {
      h.files = [photo()];
      await mount();
      await click(button(root(), "Delete"));
      expect(h.remove).toHaveBeenCalledWith({ id: "p1" });
    });

    it("shows a delete failure and re-enables the button", async () => {
      h.files = [photo()];
      h.remove.mockRejectedValue(new Error("nope"));
      await mount();
      await click(button(root(), "Delete"));
      expect(alerts()).toContain("Delete failed: nope");
      expect(button(root(), "Delete")!.props.disabled).toBe(false);
    });
  });
});
