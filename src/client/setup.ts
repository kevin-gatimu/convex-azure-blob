export type SetupCheck = { name: string; ok: boolean; hint?: string };

export type SetupResult = { ok: boolean; checks: SetupCheck[] };

/** The headers an upload ticket makes the browser send, which a CORS rule must allow. */
export const UPLOAD_HEADERS = ["x-ms-blob-type", "content-type"] as const;

const ERROR_HINTS: Record<string, string> = {
  AuthenticationFailed:
    "Azure rejected the signature: check that AZURE_BLOB_KEY is the full base64 key of this storage account and that the system clock is accurate",
  KeyBasedAuthenticationNotPermitted:
    "Shared key access is disabled on the storage account: unset AZURE_BLOB_KEY and use Microsoft Entra credentials",
  AuthorizationPermissionMismatch:
    "The identity lacks a role: assign Storage Blob Data Contributor (and Storage Blob Delegator for user delegation keys) on the account or container",
  AuthorizationFailure:
    "The request was not authorized: assign Storage Blob Data Contributor (and Storage Blob Delegator) to the identity and check the storage account firewall",
  ContainerNotFound:
    "The container does not exist: create it or fix AZURE_BLOB_CONTAINER",
};

export const NETWORK_HINT =
  "The storage endpoint is unreachable: check AZURE_BLOB_ENDPOINT, AZURE_BLOB_INTERNAL_ENDPOINT and the storage account network settings";

/** A fix hint for an Azure error response, never echoing the response body. */
export function hintForError(code: string | null, status: number) {
  return (
    (code ? ERROR_HINTS[code] : undefined) ??
    `Azure answered ${status}${code ? ` (${code})` : ""}`
  );
}

export function hintForMessage(message: string, fallback: string) {
  const code = Object.keys(ERROR_HINTS).find((known) =>
    message.includes(known),
  );
  return code ? ERROR_HINTS[code] : fallback;
}

/** Null when the preflight response allows the origin, PUT and the upload headers. */
export function corsFailure(response: Response, origin: string) {
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  const methods = (response.headers.get("access-control-allow-methods") ?? "")
    .split(",")
    .map((item) => item.trim().toUpperCase());
  const headers = (response.headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase());
  const originOk =
    response.ok && (allowedOrigin === origin || allowedOrigin === "*");
  const methodOk = methods.includes("PUT") || methods.includes("*");
  const headersOk =
    headers.includes("*") ||
    UPLOAD_HEADERS.every((header) => headers.includes(header));
  if (originOk && methodOk && headersOk) return null;
  return `The CORS preflight was not allowed: add a CORS rule on the storage account's Blob service for origin ${origin} with method PUT and allowed headers ${UPLOAD_HEADERS.join(", ")}`;
}
