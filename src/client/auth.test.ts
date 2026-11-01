import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureBlobConfig } from "./config.js";
import { getAccessToken, requestUserDelegationKey } from "./auth.js";

const config: AzureBlobConfig = {
  accountName: "acct",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "client-secret",
  authorityHost: "https://login.microsoftonline.com",
  container: "uploads",
  endpoint: "https://acct.blob.core.windows.net",
  internalEndpoint: "http://azurite:10000/acct",
};

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it("uses the client-credentials flow and the Blob Storage scope", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getAccessToken(config)).resolves.toBe("access-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({
        client_id: "client",
        client_secret: "client-secret",
        scope: "https://storage.azure.com/.default",
        grant_type: "client_credentials",
      }),
    );
  });

  it("surfaces token endpoint and malformed-response errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(getAccessToken(config)).rejects.toThrow(
      "Microsoft Entra token request failed with 401",
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({})));
    await expect(getAccessToken(config)).rejects.toThrow(
      "did not contain an access token",
    );
  });
});

describe("requestUserDelegationKey", () => {
  it("requests and parses a seven-day key using OAuth", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" })),
      )
      .mockResolvedValueOnce(
        new Response(
          `<UserDelegationKey>
            <SignedOid>11111111-2222-3333-4444-555555555555</SignedOid>
            <SignedTid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</SignedTid>
            <SignedStart>2026-01-01T11:55:00Z</SignedStart>
            <SignedExpiry>2026-01-08T11:55:00Z</SignedExpiry>
            <SignedService>b</SignedService>
            <SignedVersion>2022-11-02</SignedVersion>
            <Value>dGVzdC1rZXk=</Value>
          </UserDelegationKey>`,
        ),
      );

    await expect(
      requestUserDelegationKey(config, Date.UTC(2026, 0, 1, 12)),
    ).resolves.toEqual({
      signedObjectId: "11111111-2222-3333-4444-555555555555",
      signedTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      signedStart: "2026-01-01T11:55:00Z",
      signedExpiry: "2026-01-08T11:55:00Z",
      signedService: "b",
      signedVersion: "2022-11-02",
      keyValue: "dGVzdC1rZXk=",
    });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      "http://azurite:10000/acct/?restype=service&comp=userdelegationkey",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: "Bearer access-token",
      "content-type": "application/xml",
      "x-ms-version": "2022-11-02",
    });
    expect(init?.body).toBe(
      "<KeyInfo><Start>2026-01-01T11:55:00Z</Start><Expiry>2026-01-08T11:55:00Z</Expiry></KeyInfo>",
    );
  });

  it("surfaces Azure errors and incomplete key responses", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" })),
      )
      .mockResolvedValueOnce(
        new Response(
          "<Error><Code>AuthorizationPermissionMismatch</Code><Message>Permission denied</Message></Error>",
          {
            status: 403,
            headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" },
          },
        ),
      );
    await expect(
      requestUserDelegationKey(config, Date.UTC(2026, 0, 1)),
    ).rejects.toThrow(
      "Azure Blob user delegation key request failed with 403 (AuthorizationPermissionMismatch: Permission denied)",
    );

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" })),
      )
      .mockResolvedValueOnce(
        new Response("<UserDelegationKey></UserDelegationKey>"),
      );
    await expect(
      requestUserDelegationKey(config, Date.UTC(2026, 0, 1)),
    ).rejects.toThrow("missing SignedOid");
  });
});
