import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  blobStringToSign,
  signBlobSas,
  signUserDelegationSas,
  userDelegationStringToSign,
} from "./sas.js";

// Azurite's published development account key, so the vector is not a secret.
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const base = {
  accountName: "devstoreaccount1",
  accountKey: KEY,
  container: "uploads",
  blobName: "abc.png",
  startsOn: Date.UTC(2026, 0, 1, 0, 0, 0),
};

describe("blob service SAS", () => {
  it("signs snapshot resources and includes the exact snapshot timestamp", async () => {
    const snapshot = "2026-01-01T00:00:00.0000000Z";
    const input = {
      ...base,
      permissions: "r",
      expiresOn: base.startsOn + 60_000,
      snapshot,
    };
    expect(blobStringToSign(input).split("\n").slice(8, 11)).toEqual([
      "bs",
      snapshot,
      "",
    ]);
    const params = new URLSearchParams(await signBlobSas(input));
    expect(params.get("sr")).toBe("bs");
    expect(params.get("snapshot")).toBe(snapshot);
    expect(params.get("sig")).not.toBe(
      new URLSearchParams(
        await signBlobSas({ ...input, snapshot: undefined }),
      ).get("sig"),
    );
  });
  it("builds the 2022-11-02 string-to-sign with empty optional fields", () => {
    const stringToSign = blobStringToSign({
      ...base,
      permissions: "r",
      expiresOn: Date.UTC(2026, 0, 1, 1, 0, 0),
    });
    expect(stringToSign).toBe(
      "r\n2026-01-01T00:00:00Z\n2026-01-01T01:00:00Z\n/blob/devstoreaccount1/uploads/abc.png\n\n\n\n2022-11-02\nb\n\n\n\n\n\n\n",
    );
  });

  // Expected signatures come from an independent HMAC-SHA256 over the strings above (Python hmac).
  it("signs a read token that matches the independent HMAC", async () => {
    const query = await signBlobSas({
      ...base,
      permissions: "r",
      expiresOn: Date.UTC(2026, 0, 1, 1, 0, 0),
    });
    const params = new URLSearchParams(query);
    expect(params.get("sig")).toBe(
      "Uq67ZXf8TyI/hbhACP7wJODs8jSlEE3B6CL/xDusb3Q=",
    );
    expect(Object.fromEntries(params)).toMatchObject({
      sv: "2022-11-02",
      sr: "b",
      sp: "r",
      st: "2026-01-01T00:00:00Z",
      se: "2026-01-01T01:00:00Z",
    });
  });

  it("scopes a create token to its own expiry and permission", async () => {
    const query = await signBlobSas({
      ...base,
      permissions: "c",
      expiresOn: Date.UTC(2026, 0, 1, 0, 5, 0),
    });
    const params = new URLSearchParams(query);
    expect(params.get("sp")).toBe("c");
    expect(params.get("se")).toBe("2026-01-01T00:05:00Z");
    expect(params.get("sig")).toBe(
      "LgaxLM+aF4CyvrzHFi0EbQo1NF51IoRxL82PB8M24us=",
    );
  });

  it("rejects permissions out of Azure's order, repeated, or empty", async () => {
    const input = { ...base, expiresOn: base.startsOn + 1000 };
    await expect(
      signBlobSas({ ...input, permissions: "wr" }),
    ).rejects.toThrow();
    await expect(
      signBlobSas({ ...input, permissions: "rr" }),
    ).rejects.toThrow();
    await expect(signBlobSas({ ...input, permissions: "" })).rejects.toThrow();
    await expect(signBlobSas({ ...input, permissions: "x" })).rejects.toThrow();
  });

  it("rejects an expiry that is not after the start", async () => {
    await expect(
      signBlobSas({ ...base, permissions: "r", expiresOn: base.startsOn }),
    ).rejects.toThrow("expiry");
  });

  // The expected signature is an independent HMAC (Node's crypto) over the string below.
  it("signs protocol, IP range and response header overrides", async () => {
    const input = {
      ...base,
      blobName: "photos/abc.png",
      permissions: "r",
      expiresOn: Date.UTC(2026, 0, 1, 1, 0, 0),
      protocol: "https" as const,
      ipRange: "198.51.100.10-198.51.100.20",
      responseHeaders: {
        cacheControl: "public, max-age=60",
        contentDisposition: 'attachment; filename="a.png"',
      },
    };
    expect(blobStringToSign(input)).toBe(
      [
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T01:00:00Z",
        "/blob/devstoreaccount1/uploads/photos/abc.png",
        "",
        "198.51.100.10-198.51.100.20",
        "https",
        "2022-11-02",
        "b",
        "",
        "",
        "public, max-age=60",
        'attachment; filename="a.png"',
        "",
        "",
        "",
      ].join("\n"),
    );
    const params = new URLSearchParams(await signBlobSas(input));
    expect(params.get("sig")).toBe(
      "DT/N/iV5wntheof9uxyUllT33UNkhiwB96gtbr5gfzE=",
    );
    expect(params.get("spr")).toBe("https");
    expect(params.get("sip")).toBe("198.51.100.10-198.51.100.20");
    expect(params.get("rscc")).toBe("public, max-age=60");
    expect(params.get("rscd")).toBe('attachment; filename="a.png"');
    expect(params.has("rsct")).toBe(false);
  });
});

describe("user delegation SAS", () => {
  const delegationKey = {
    keyValue: "dGVzdC11c2VyLWRlbGVnYXRpb24ta2V5",
    signedObjectId: "11111111-2222-3333-4444-555555555555",
    signedTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    signedStart: "2026-01-01T00:00:00Z",
    signedExpiry: "2026-01-08T00:00:00Z",
    signedService: "b",
    signedVersion: "2022-11-02",
  };
  const input = {
    accountName: "acct",
    container: "uploads",
    blobName: "folder/a.png",
    permissions: "r",
    startsOn: Date.UTC(2026, 0, 1, 0, 10, 0),
    expiresOn: Date.UTC(2026, 0, 1, 1, 10, 0),
    protocol: "https" as const,
    delegationKey,
  };
  it("signs the snapshot timestamp and bs resource in a delegation SAS", async () => {
    const snapshot = "2026-01-01T00:30:00.0000000Z";
    const snapshotInput = { ...input, snapshot };
    expect(
      userDelegationStringToSign(snapshotInput).split("\n").slice(16, 19),
    ).toEqual(["bs", snapshot, ""]);
    const params = new URLSearchParams(
      await signUserDelegationSas(snapshotInput),
    );
    expect(params.get("sr")).toBe("bs");
    expect(params.get("snapshot")).toBe(snapshot);
    expect(params.get("sig")).not.toBe(
      new URLSearchParams(await signUserDelegationSas(input)).get("sig"),
    );
  });

  it("uses the 2020-12-06 user delegation string-to-sign field order", () => {
    expect(userDelegationStringToSign(input)).toBe(
      [
        "r",
        "2026-01-01T00:10:00Z",
        "2026-01-01T01:10:00Z",
        "/blob/acct/uploads/folder/a.png",
        delegationKey.signedObjectId,
        delegationKey.signedTenantId,
        delegationKey.signedStart,
        delegationKey.signedExpiry,
        "b",
        "2022-11-02",
        "",
        "",
        "",
        "",
        "https",
        "2022-11-02",
        "b",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join("\n"),
    );
  });

  // Expected signature is an independent HMAC-SHA256 vector computed with Python hmac.
  it("signs a user delegation token against the independent HMAC vector", async () => {
    const query = await signUserDelegationSas(input);
    const params = new URLSearchParams(query);
    expect(params.get("sig")).toBe(
      "Znw9JAshWRWsi7rPSboUhO1BXQHYoyCMvemlCoxmaCw=",
    );
    expect(Object.fromEntries(params)).toMatchObject({
      sv: "2022-11-02",
      sr: "b",
      sp: "r",
      st: "2026-01-01T00:10:00Z",
      se: "2026-01-01T01:10:00Z",
      skoid: delegationKey.signedObjectId,
      sktid: delegationKey.signedTenantId,
      skt: delegationKey.signedStart,
      ske: delegationKey.signedExpiry,
      sks: "b",
      skv: "2022-11-02",
      spr: "https",
    });
  });

  it("rejects a SAS that outlives its delegation key", async () => {
    await expect(
      signUserDelegationSas({
        ...input,
        expiresOn: Date.UTC(2026, 0, 9),
      }),
    ).rejects.toThrow("fit within the user delegation key");
  });
});

describe("attachmentDisposition", () => {
  it("keeps ASCII names and adds the RFC 5987 form", () => {
    expect(attachmentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("replaces quotes and non-ASCII in the fallback and percent-encodes the UTF-8 form", () => {
    expect(attachmentDisposition('naïve "draft" (1).png')).toBe(
      `attachment; filename="na_ve _draft_ (1).png"; filename*=UTF-8''na%C3%AFve%20%22draft%22%20%281%29.png`,
    );
  });
});
