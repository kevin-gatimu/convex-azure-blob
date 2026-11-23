import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

const env = {
  AZURE_BLOB_ACCOUNT: "acct",
  AZURE_BLOB_KEY: "a2V5",
  AZURE_BLOB_CONTAINER: "uploads",
  AZURE_BLOB_ENDPOINT: "https://acct.blob.core.windows.net/",
};

describe("resolveConfig", () => {
  it("reads the environment and trims trailing slashes", () => {
    expect(resolveConfig(undefined, env)).toEqual({
      accountName: "acct",
      accountKey: "a2V5",
      tenantId: undefined,
      clientId: undefined,
      clientSecret: undefined,
      authorityHost: "https://login.microsoftonline.com",
      container: "uploads",
      endpoint: "https://acct.blob.core.windows.net",
      internalEndpoint: undefined,
      publicBaseUrl: undefined,
    });
  });

  it("prefers explicit values and reads the optional endpoints", () => {
    const config = resolveConfig(
      { container: "other" },
      {
        ...env,
        AZURE_BLOB_INTERNAL_ENDPOINT: "http://azurite:10000/acct/",
        AZURE_BLOB_PUBLIC_BASE_URL: "https://cdn.example/",
      },
    );
    expect(config.container).toBe("other");
    expect(config.internalEndpoint).toBe("http://azurite:10000/acct");
    expect(config.publicBaseUrl).toBe("https://cdn.example");
  });

  it("names every missing variable", () => {
    expect(() => resolveConfig(undefined, {})).toThrow(
      "AZURE_BLOB_ACCOUNT, AZURE_BLOB_CONTAINER, AZURE_BLOB_ENDPOINT",
    );
  });

  it("accepts Entra client credentials without an account key", () => {
    expect(
      resolveConfig(undefined, {
        AZURE_BLOB_ACCOUNT: "acct",
        AZURE_BLOB_CONTAINER: "uploads",
        AZURE_BLOB_ENDPOINT: "https://acct.blob.core.windows.net",
        AZURE_BLOB_TENANT_ID: "tenant",
        AZURE_BLOB_CLIENT_ID: "client",
        AZURE_BLOB_CLIENT_SECRET: "secret",
        AZURE_BLOB_AUTHORITY_HOST: "https://login.microsoftonline.us/",
      }),
    ).toEqual({
      accountName: "acct",
      accountKey: undefined,
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      authorityHost: "https://login.microsoftonline.us",
      container: "uploads",
      endpoint: "https://acct.blob.core.windows.net",
      internalEndpoint: undefined,
      publicBaseUrl: undefined,
    });
  });

  it("prefers an account key when both authentication methods are configured", () => {
    const config = resolveConfig(undefined, {
      ...env,
      AZURE_BLOB_TENANT_ID: "tenant",
      AZURE_BLOB_CLIENT_ID: "client",
      AZURE_BLOB_CLIENT_SECRET: "secret",
    });
    expect(config.accountKey).toBe("a2V5");
  });

  it("reports missing Entra credentials when no account key is configured", () => {
    expect(() =>
      resolveConfig(undefined, {
        AZURE_BLOB_ACCOUNT: "acct",
        AZURE_BLOB_CONTAINER: "uploads",
        AZURE_BLOB_ENDPOINT: "https://acct.blob.core.windows.net",
        AZURE_BLOB_TENANT_ID: "tenant",
      }),
    ).toThrow(
      "requires AZURE_BLOB_KEY or all Microsoft Entra client credentials; missing: AZURE_BLOB_CLIENT_ID, AZURE_BLOB_CLIENT_SECRET",
    );
  });

  it("never echoes a credential or endpoint value in a configuration error", () => {
    const accountKey = "c2VjcmV0LWFjY291bnQta2V5";
    const clientSecret = "very-secret-client-secret";
    const endpoint = "https://private-account.blob.core.windows.net";
    const errors: Error[] = [];
    for (const attempt of [
      () => resolveConfig({ accountKey, endpoint }, {}),
      () =>
        resolveConfig(
          { endpoint, clientSecret },
          { AZURE_BLOB_ACCOUNT: "acct", AZURE_BLOB_CONTAINER: "uploads" },
        ),
      () =>
        resolveConfig(undefined, {
          AZURE_BLOB_ACCOUNT: "acct",
          AZURE_BLOB_CONTAINER: "uploads",
          AZURE_BLOB_ENDPOINT: endpoint,
          AZURE_BLOB_CLIENT_SECRET: clientSecret,
        }),
    ]) {
      try {
        attempt();
      } catch (error) {
        errors.push(error as Error);
      }
    }
    expect(errors).toHaveLength(3);
    for (const error of errors)
      for (const secret of [accountKey, clientSecret, endpoint])
        expect(error.message.includes(secret)).toBe(false);
    expect(errors[0]!.message).toContain("AZURE_BLOB_ACCOUNT");
    expect(errors[1]!.message).toContain("AZURE_BLOB_TENANT_ID");
    expect(errors[2]!.message).toContain("AZURE_BLOB_TENANT_ID");
  });
});
