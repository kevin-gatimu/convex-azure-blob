import { describe, expect, test } from "vitest";
import {
  ACCEPT_FILES,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_BYTES,
  normalizeFile,
} from "./upload-policy";

describe("upload policy", () => {
  test("allows the images, PDF, ZIP, MP4, WebM and MP3 the demo advertises", () => {
    expect(ALLOWED_CONTENT_TYPES).toEqual({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "application/pdf": "pdf",
      "application/zip": "zip",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
    });
  });

  test("allows 4000 MiB per block across 50000 blocks", () => {
    expect(MAX_FILE_BYTES).toBe(4000 * 1024 * 1024 * 50_000);
    expect(Number.isSafeInteger(MAX_FILE_BYTES)).toBe(true);
  });

  test("accept list names every type and extension, plus .jpeg", () => {
    const accepted = ACCEPT_FILES.split(",");
    for (const [type, extension] of Object.entries(ALLOWED_CONTENT_TYPES)) {
      expect(accepted).toContain(type);
      expect(accepted).toContain(`.${extension}`);
    }
    expect(accepted).toContain(".jpeg");
  });
});

describe("normalizeFile", () => {
  test("returns a file with an allowed type untouched", () => {
    const file = new File(["x"], "report.bin", { type: "application/pdf" });
    expect(normalizeFile(file)).toBe(file);
  });

  test.each([
    ["report.pdf", "application/pdf"],
    ["REPORT.PDF", "application/pdf"],
    ["photo.jpeg", "image/jpeg"],
    ["photo.JPG", "image/jpeg"],
    ["bundle.zip", "application/zip"],
    ["clip.webm", "video/webm"],
    ["song.mp3", "audio/mpeg"],
  ])("fills in the type of %s from its extension", (name, type) => {
    const file = new File(["abc"], name, {
      type: "application/octet-stream",
      lastModified: 1234,
    });
    const normalized = normalizeFile(file);
    expect(normalized.type).toBe(type);
    expect(normalized.name).toBe(name);
    expect(normalized.size).toBe(3);
    expect(normalized.lastModified).toBe(1234);
  });

  test("leaves unsupported extensions unchanged", () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    expect(normalizeFile(file)).toBe(file);
    expect(normalizeFile(new File(["x"], "setup.exe")).type).toBe("");
  });
});
