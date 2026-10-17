import { describe, expect, it } from "vitest";
import { SNIFFABLE_CONTENT_TYPES, sniffContentType } from "./sniff.js";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string"
        ? [...part].map((char) => char.charCodeAt(0))
        : part,
    ),
  );

// An ISO-BMFF `ftyp` box: size, "ftyp", major brand, minor version, compatible brands.
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + 4 * compatible.length;
  return bytes([0, 0, 0, size], "ftyp", major, [0, 0, 0, 0], ...compatible);
};

describe("sniffContentType", () => {
  it.each([
    ["image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])],
    ["image/png", bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/gif", bytes("GIF89a")],
    ["image/gif", bytes("GIF87a")],
    ["image/webp", bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 ")],
    ["image/avif", ftyp("avif", "mif1", "miaf")],
    ["image/avif", ftyp("mif1", "avif")],
    ["image/heic", ftyp("heic", "mif1")],
    ["application/pdf", bytes("%PDF-1.7")],
    ["application/zip", bytes("PK", [3, 4])],
    ["video/mp4", ftyp("isom", "mp41")],
    ["video/webm", bytes([0x1a, 0x45, 0xdf, 0xa3])],
    ["audio/mpeg", bytes("ID3", [4, 0])],
    ["audio/mpeg", bytes([0xff, 0xfb, 0x90])],
  ])("accepts a real %s signature", (type, sample) => {
    expect(sniffContentType(type, sample)).toBe(true);
  });

  it("rejects HTML or another format posing as an image", () => {
    const html = bytes("<!doctype html><script>alert(1)</script>");
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
    ]) {
      expect(sniffContentType(type, html)).toBe(false);
    }
    expect(sniffContentType("image/png", bytes([0xff, 0xd8, 0xff]))).toBe(
      false,
    );
    expect(sniffContentType("image/avif", ftyp("isom", "mp41"))).toBe(false);
  });

  it("rejects truncated input", () => {
    expect(sniffContentType("image/png", new Uint8Array())).toBe(false);
    expect(sniffContentType("image/webp", bytes("RIFF"))).toBe(false);
  });

  it("does not judge types without a known signature", () => {
    expect(sniffContentType("text/plain", bytes("hello"))).toBeUndefined();
    expect(sniffContentType("image/svg+xml", bytes("<svg/>"))).toBeUndefined();
    expect(SNIFFABLE_CONTENT_TYPES).toContain("image/png");
  });
});
