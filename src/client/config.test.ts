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
      "AZURE_BLOB_ACCOUNT, AZURE_BLOB_KEY, AZURE_BLOB_CONTAINER, AZURE_BLOB_ENDPOINT",
    );
  });
});
