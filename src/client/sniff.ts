/** How many leading bytes `confirmUpload` reads to check a file's signature. */
export const SNIFF_BYTES = 64;

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, i) => bytes[i] === byte);

/** ISO base media files (MP4, AVIF, HEIC) carry `ftyp` at offset 4 followed by brands. */
function hasBrand(bytes: Uint8Array, brands: readonly string[]) {
  if (!ascii(bytes, 4, "ftyp")) return false;
  const boxSize = Math.min(
    ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0),
    bytes.length,
  );
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (brands.some((brand) => ascii(bytes, offset, brand))) return true;
  }
  return false;
}

const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/png": (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/gif": (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"),
  "image/webp": (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  "image/avif": (b) => hasBrand(b, ["avif", "avis"]),
  "image/heic": (b) => hasBrand(b, ["heic", "heix", "heim", "heis"]),
  "application/pdf": (b) => ascii(b, 0, "%PDF-"),
  "application/zip": (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  "video/mp4": (b) => ascii(b, 4, "ftyp"),
  "video/webm": (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  "audio/mpeg": (b) =>
    ascii(b, 0, "ID3") ||
    ((b[0] ?? 0) === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
};

/** Content types whose leading bytes `sniffContentType` can check. */
export const SNIFFABLE_CONTENT_TYPES: readonly string[] =
  Object.keys(SIGNATURES);

/**
 * Whether the leading bytes match the content type's file signature.
 * Returns `undefined` for types without a known signature (text formats, for example).
 */
export function sniffContentType(
  contentType: string,
  bytes: Uint8Array,
): boolean | undefined {
  return SIGNATURES[contentType]?.(bytes);
}
