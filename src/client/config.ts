export type AzureBlobConfig = {
  accountName: string;
  /** Base64 storage account key. Preferred over Microsoft Entra credentials when set. */
  accountKey?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** Authority base URL for Microsoft Entra ID. Defaults to https://login.microsoftonline.com. */
  authorityHost?: string;
  container: string;
  /** Account URL the browser uses, e.g. https://acct.blob.core.windows.net or http://127.0.0.1:10000/devstoreaccount1. */
  endpoint: string;
  /** Account URL the Convex deployment uses when it differs from what the browser sees (Docker). */
  internalEndpoint?: string;
  /** Serve this base URL as-is instead of signing reads, e.g. a CDN in front of a public container. */
  publicBaseUrl?: string;
};

const ENV_NAMES = {
  accountName: "AZURE_BLOB_ACCOUNT",
  accountKey: "AZURE_BLOB_KEY",
  container: "AZURE_BLOB_CONTAINER",
  endpoint: "AZURE_BLOB_ENDPOINT",
} as const;

const ENTRA_ENV_NAMES = {
  tenantId: "AZURE_BLOB_TENANT_ID",
  clientId: "AZURE_BLOB_CLIENT_ID",
  clientSecret: "AZURE_BLOB_CLIENT_SECRET",
} as const;

export const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";

const trimSlash = (value: string) => value.replace(/\/+$/, "");

/** Explicit values win over the environment; throws naming the missing variables. */
export function resolveConfig(
  explicit: Partial<AzureBlobConfig> | undefined,
  env: Record<string, string | undefined>,
): AzureBlobConfig {
  const pick = (key: keyof typeof ENV_NAMES) =>
    explicit?.[key] || env[ENV_NAMES[key]];
  const values = {
    accountName: pick("accountName"),
    accountKey: pick("accountKey"),
    container: pick("container"),
    endpoint: pick("endpoint"),
  };
  const missing = (["accountName", "container", "endpoint"] as const)
    .filter((key) => !values[key])
    .map((key) => ENV_NAMES[key]);
  if (missing.length > 0) {
    throw new Error(
      `Azure Blob configuration is missing: ${missing.join(", ")}`,
    );
  }
  const entra = {
    tenantId: explicit?.tenantId || env[ENTRA_ENV_NAMES.tenantId],
    clientId: explicit?.clientId || env[ENTRA_ENV_NAMES.clientId],
    clientSecret: explicit?.clientSecret || env[ENTRA_ENV_NAMES.clientSecret],
  };
  if (!values.accountKey) {
    const missingEntra = (
      Object.keys(ENTRA_ENV_NAMES) as (keyof typeof ENTRA_ENV_NAMES)[]
    )
      .filter((key) => !entra[key])
      .map((key) => ENTRA_ENV_NAMES[key]);
    if (missingEntra.length > 0) {
      throw new Error(
        `Azure Blob configuration requires AZURE_BLOB_KEY or all Microsoft Entra client credentials; missing: ${missingEntra.join(", ")}`,
      );
    }
  }
  const internal =
    explicit?.internalEndpoint || env.AZURE_BLOB_INTERNAL_ENDPOINT;
  const publicBase = explicit?.publicBaseUrl || env.AZURE_BLOB_PUBLIC_BASE_URL;
  const authorityHost = trimSlash(
    explicit?.authorityHost ||
      env.AZURE_BLOB_AUTHORITY_HOST ||
      DEFAULT_AUTHORITY_HOST,
  );
  return {
    accountName: values.accountName ?? "",
    accountKey: values.accountKey || undefined,
    ...entra,
    authorityHost,
    container: values.container ?? "",
    endpoint: trimSlash(values.endpoint ?? ""),
    internalEndpoint: internal ? trimSlash(internal) : undefined,
    publicBaseUrl: publicBase ? trimSlash(publicBase) : undefined,
  };
}
