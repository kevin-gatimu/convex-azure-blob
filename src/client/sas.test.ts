import { describe, expect, it } from "vitest";
import { attachmentDisposition, blobStringToSign, signBlobSas } from "./sas.js";

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
