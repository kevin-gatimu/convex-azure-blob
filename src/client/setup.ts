export type SetupCheck = { name: string; ok: boolean; hint?: string };

export type SetupResult = { ok: boolean; checks: SetupCheck[] };

/** The headers the browser uploader sends in this mode, which a CORS rule must allow. */
export function uploadHeaders(blocks: boolean, checksum: boolean) {
  return [
    ...(blocks ? [] : ["x-ms-blob-type"]),
    "content-type",
    // Block uploads reject md5, so their browser requests never carry Content-MD5.
    ...(checksum && !blocks ? ["content-md5"] : []),
  ];
}

const ERROR_HINTS: Record<string, string> = {
  AuthenticationFailed:
    "Azure rejected the signature: check that AZURE_BLOB_KEY is the full base64 key of this storage account and that the system clock is accurate",
  KeyBasedAuthenticationNotPermitted:
    "Shared key access is disabled on the storage account: unset AZURE_BLOB_KEY and use Microsoft Entra credentials",
  AuthorizationPermissionMismatch:
    "The identity lacks a role: assign Storage Blob Data Contributor at the storage account or container scope, and Storage Blob Delegator at the storage account scope or above (not the container)",
  AuthorizationFailure:
    "The request was not authorized: either the account key or the system clock is wrong, or the storage account firewall or network rules block this caller (for example Convex egress)",
  ContainerNotFound:
    "The container does not exist: create it or fix AZURE_BLOB_CONTAINER",
};

export const DELEGATOR_HINT =
  "Azure refused the user delegation key request: assign Storage Blob Delegator to the identity at the storage account scope or above";

export const ENTRA_SIGNATURE_HINT =
  "Azure rejected the user delegation SAS: check that AZURE_BLOB_ACCOUNT is the name of the storage account the identity belongs to and that the system clock is accurate, or that the storage account firewall or network rules allow this caller";

export const KEY_FORMAT_HINT =
  "AZURE_BLOB_KEY is not a valid base64 account key: copy the full key from the storage account access keys";

export const NETWORK_HINT =
  "The storage endpoint is unreachable: check AZURE_BLOB_ENDPOINT, AZURE_BLOB_INTERNAL_ENDPOINT and the storage account network settings";

/** A fix hint for an Azure error response, never echoing the response body. */
export function hintForError(code: string | null, status: number) {
  return (
    (code ? ERROR_HINTS[code] : undefined) ??
    `Azure answered ${status}${code ? ` (${code})` : ""}`
  );
}

/** A fixed hint for a token failure, keeping only the status of the package's own error. */
export function tokenHint(error: unknown) {
  const status = (
    error instanceof Error
      ? /^Microsoft Entra token request failed with (\d{3})$/.exec(
          error.message,
        )
      : null
  )?.[1];
  return `Could not get a Microsoft Entra token: ${status ? `the token request failed with ${status}` : "check the tenant id, client id, client secret and authority host"}`;
}

/** The package's own configuration message, or a generic one for anything else. */
export function configHint(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^Azure Blob configuration (is missing|requires AZURE_BLOB_KEY or all Microsoft Entra client credentials; missing): [A-Z_]+(, [A-Z_]+)*$/.test(
    message,
  )
    ? message
    : "Invalid configuration";
}

export function hintForMessage(message: string, fallback: string) {
  const code = Object.keys(ERROR_HINTS).find((known) =>
    message.includes(known),
  );
  return code ? ERROR_HINTS[code] : fallback;
}

/** Null when the preflight response allows the origin, PUT and the upload headers. */
export function corsFailure(
  response: Response,
  origin: string,
  required: string[],
) {
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
    required.every((header) => headers.includes(header));
  if (originOk && methodOk && headersOk) return null;
  return `The CORS preflight was not allowed: add a CORS rule on the storage account's Blob service for origin ${origin} with method PUT and allowed headers ${required.join(", ")}`;
}
