export type AzureBlobConfig = {
  accountName: string;
  /** Base64 storage account key. */
  accountKey: string;
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
  const missing = (Object.keys(ENV_NAMES) as (keyof typeof ENV_NAMES)[])
    .filter((key) => !values[key])
    .map((key) => ENV_NAMES[key]);
  if (missing.length > 0) {
    throw new Error(
      `Azure Blob configuration is missing: ${missing.join(", ")}`,
    );
  }
  const internal =
    explicit?.internalEndpoint || env.AZURE_BLOB_INTERNAL_ENDPOINT;
  const publicBase = explicit?.publicBaseUrl || env.AZURE_BLOB_PUBLIC_BASE_URL;
  return {
    accountName: values.accountName ?? "",
    accountKey: values.accountKey ?? "",
    container: values.container ?? "",
    endpoint: trimSlash(values.endpoint ?? ""),
    internalEndpoint: internal ? trimSlash(internal) : undefined,
    publicBaseUrl: publicBase ? trimSlash(publicBase) : undefined,
  };
}
