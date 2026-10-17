/**
 * Service SAS signing for blob resources (version 2022-11-02) with Web Crypto only,
 * so it runs in the default Convex runtime without the Azure SDK or `"use node"`.
 *
 * @see https://learn.microsoft.com/rest/api/storageservices/create-service-sas
 */
export const SAS_VERSION = "2022-11-02";

// Azure requires blob permission letters in this order.
const PERMISSION_ORDER = "racwd";

/** Response headers a read SAS can override for whoever uses it. */
export type SasResponseHeaders = {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
};

export type BlobSasInput = {
  accountName: string;
  /** Base64 storage account key. */
  accountKey: string;
  container: string;
  /** Unencoded blob name, e.g. `avatars/3f1c.png`. */
  blobName: string;
  /** Subset of "racwd" in that order, e.g. "r" or "c". */
  permissions: string;
  /** Epoch milliseconds. */
  startsOn: number;
  /** Epoch milliseconds. */
  expiresOn: number;
  /** `"https"` rejects requests over plain HTTP. Omit to allow both. */
  protocol?: "https" | "https,http";
  /** One IPv4 address or an inclusive range `a.b.c.d-e.f.g.h`. */
  ipRange?: string;
  responseHeaders?: SasResponseHeaders;
};

/** ISO 8601 UTC without milliseconds, the form Azure signs. */
export function sasTime(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertPermissions(permissions: string) {
  if (permissions.length === 0) throw new Error("SAS permissions are empty");
  let last = -1;
  for (const letter of permissions) {
    const index = PERMISSION_ORDER.indexOf(letter);
    if (index <= last)
      throw new Error(`Invalid SAS permissions "${permissions}"`);
    last = index;
  }
}

/** The string-to-sign for version 2020-12-06 and later; unused optional fields stay empty. */
export function blobStringToSign(input: BlobSasInput) {
  const headers = input.responseHeaders ?? {};
  return [
    input.permissions,
    sasTime(input.startsOn),
    sasTime(input.expiresOn),
    `/blob/${input.accountName}/${input.container}/${input.blobName}`,
    "", // signedIdentifier (stored access policy)
    input.ipRange ?? "",
    input.protocol ?? "",
    SAS_VERSION,
    "b", // signedResource: blob
    "", // signedSnapshotTime
    "", // signedEncryptionScope
    headers.cacheControl ?? "",
    headers.contentDisposition ?? "",
    headers.contentEncoding ?? "",
    headers.contentLanguage ?? "",
    headers.contentType ?? "",
  ].join("\n");
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function hmacSha256Base64(base64Key: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(base64Key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToBase64(new Uint8Array(signature));
}

/** The SAS query string (without a leading "?") for one blob. */
export async function signBlobSas(input: BlobSasInput) {
  assertPermissions(input.permissions);
  if (input.expiresOn <= input.startsOn)
    throw new Error("SAS expiry must be after its start");
  const signature = await hmacSha256Base64(
    input.accountKey,
    blobStringToSign(input),
  );
  const params = new URLSearchParams({
    sv: SAS_VERSION,
    st: sasTime(input.startsOn),
    se: sasTime(input.expiresOn),
    sr: "b",
    sp: input.permissions,
  });
  if (input.protocol) params.set("spr", input.protocol);
  if (input.ipRange) params.set("sip", input.ipRange);
  const headers = input.responseHeaders ?? {};
  const overrides = [
    ["rscc", headers.cacheControl],
    ["rscd", headers.contentDisposition],
    ["rsce", headers.contentEncoding],
    ["rscl", headers.contentLanguage],
    ["rsct", headers.contentType],
  ] as const;
  for (const [name, value] of overrides) if (value) params.set(name, value);
  params.set("sig", signature);
  return params.toString();
}

/**
 * A `Content-Disposition` value that makes browsers download the file under `fileName`,
 * with an ASCII fallback and the RFC 5987 UTF-8 form for other characters.
 */
export function attachmentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
