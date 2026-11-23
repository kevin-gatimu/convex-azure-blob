/// <reference types="vite/client" />
// Opt-in, never in CI: runs against a real account only when AZURE_LIVE=1 (npm run test:live).
// Output must never contain a key, token or SAS URL, so assertions compare statuses, not URLs.
import { createHash, randomUUID } from "node:crypto";
import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import componentTest, { register } from "../test.js";
import { AzureBlob } from "./index.js";
import type { AzureBlobConfig, AzureBlobOptions } from "./index.js";
import { getAccessToken } from "./auth.js";
import { blockId } from "./blocks.js";
import { SAS_VERSION, signBlobSas } from "./sas.js";

const TIMEOUT = 60_000;
const env = (name: string) => process.env[`AZURE_LIVE_${name}`] || undefined;

const enabled = process.env.AZURE_LIVE === "1";
const origin = env("ORIGIN");
const copySource = env("COPY_SOURCE");
const runId = randomUUID().slice(0, 8);
const pathPrefix = `live-test/${runId}`;

/** The account a group runs against; the shared key group may use its own (SHARED_KEY_*). */
function target(prefix: "" | "SHARED_KEY_") {
  const own = prefix && env(`${prefix}ACCOUNT`);
  const accountName = own || env("ACCOUNT");
  const container = (own && env(`${prefix}CONTAINER`)) || env("CONTAINER");
  const endpoint = (
    (own ? env(`${prefix}ENDPOINT`) : env("ENDPOINT")) ??
    `https://${accountName}.blob.core.windows.net`
  ).replace(/\/+$/, "");
  return enabled && accountName && container
    ? { accountName, container, endpoint }
    : null;
}

const sharedKeyTarget = target("SHARED_KEY_");
const accountKey = env("SHARED_KEY") ?? env("KEY");
const sharedKeyConfig: Partial<AzureBlobConfig> | null =
  sharedKeyTarget && accountKey ? { ...sharedKeyTarget, accountKey } : null;
const entraTarget = target("");
const entraConfig: Partial<AzureBlobConfig> | null =
  entraTarget && env("TENANT_ID") && env("CLIENT_ID") && env("CLIENT_SECRET")
    ? {
        ...entraTarget,
        tenantId: env("TENANT_ID"),
        clientId: env("CLIENT_ID"),
        clientSecret: env("CLIENT_SECRET"),
      }
    : null;

// A 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
// JPEG magic bytes behind a declared image/png.
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch that never lets a URL (which carries the SAS) into an error message. */
async function call(url: string | URL, init: RequestInit = {}) {
  try {
    return await fetch(url, { redirect: "manual", ...init });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : "unknown";
    throw new Error(`live request failed (${code})`);
  }
}

async function bytesOf(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

function newTest() {
  return convexTest(defineSchema({}), componentTest.modules);
}

function defineLiveSuite(
  mode: "shared key" | "Microsoft Entra",
  config: Partial<AzureBlobConfig> | null,
) {
  const entra = mode === "Microsoft Entra";
  const test = (name: string, fn: () => Promise<void>) =>
    it.skipIf(!config)(name, fn, TIMEOUT);

  describe.skipIf(!config)(`live Azure, ${mode}`, () => {
    const t = newTest();
    const component = register(t);
    const created: { azure: AzureBlob; fileId: string }[] = [];

    const client = (options: AzureBlobOptions = {}) =>
      new AzureBlob(component, { config: config!, pathPrefix, ...options });

    beforeAll(async () => {
      if (entra) {
        const azure = client();
        await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
      }
    }, TIMEOUT);

    // Best effort: a failed purge is reported by id and count, never by URL.
    afterEach(async () => {
      const batch = created.splice(0);
      const leaked: string[] = [];
      for (const { azure, fileId } of batch) {
        try {
          await t.action((ctx) => azure.purge(ctx, fileId));
        } catch {
          leaked.push(fileId);
        }
      }
      if (leaked.length > 0)
        console.warn(
          `live cleanup failed for ${leaked.length} file(s) under ${pathPrefix}: ${leaked.join(", ")}`,
        );
    }, TIMEOUT);

    const confirm = (azure: AzureBlob, fileId: string) =>
      t.action((ctx) => azure.confirmUpload(ctx, fileId));

    async function upload(
      azure: AzureBlob,
      body: BodyInit = PNG,
      args: { md5?: string; size?: number } = {},
      headers: Record<string, string> = {},
    ) {
      const ticket = await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "live-test",
          fileName: "live pixel.png",
          ...args,
        }),
      );
      created.push({ azure, fileId: ticket.fileId });
      const put = await call(ticket.uploadUrl, {
        method: "PUT",
        headers: { ...ticket.headers, ...headers },
        body,
      });
      return { ticket, put };
    }

    async function ready(azure: AzureBlob, body: BodyInit = PNG) {
      const { ticket, put } = await upload(azure, body);
      expect(put.status).toBe(201);
      expect(await confirm(azure, ticket.fileId)).toMatchObject({ ok: true });
      const url = await t.query((ctx) => azure.getUrl(ctx, ticket.fileId));
      expect(url).not.toBeNull();
      return { ticket, url: url! };
    }

    /** Status of a server-signed HEAD, independent of the file row. */
    async function blobStatus(azure: AzureBlob, fileId: string) {
      const file = await t.query((ctx) => azure.getFile(ctx, fileId));
      const name = file!.blobName.split("/").map(encodeURIComponent).join("/");
      const url = `${config!.endpoint}/${config!.container}/${name}`;
      if (config!.accountKey) {
        const now = Date.now();
        const sas = await signBlobSas({
          accountName: config!.accountName!,
          accountKey: config!.accountKey,
          container: config!.container!,
          blobName: file!.blobName,
          permissions: "r",
          startsOn: now - 5 * 60_000,
          expiresOn: now + 5 * 60_000,
        });
        return (await call(`${url}?${sas}`, { method: "HEAD" })).status;
      }
      const token = await getAccessToken(config as AzureBlobConfig);
      return (
        await call(url, {
          method: "HEAD",
          headers: {
            authorization: `Bearer ${token}`,
            "x-ms-version": SAS_VERSION,
          },
        })
      ).status;
    }

    test("checkSetup passes and leaks no credential", async () => {
      const azure = client();
      const result = await t.action((ctx) =>
        azure.checkSetup(ctx, origin ? { origin } : {}),
      );
      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual(
        expect.arrayContaining(["config", "credentials", "container"]),
      );
      if (origin) expect(result.checks.at(-1)?.name).toBe("cors");
      const json = JSON.stringify(result);
      const secrets = [config!.accountKey, config!.clientSecret].filter(
        (secret): secret is string => Boolean(secret),
      );
      expect(secrets.some((secret) => json.includes(secret))).toBe(false);
      expect(/sig=|sv=|Bearer|eyJ/.test(json)).toBe(false);
    });

    test("uploads with a ticket, reads the same bytes back and downloads as an attachment", async () => {
      const azure = client();
      const { ticket, url } = await ready(azure);
      const read = await call(url);
      expect(read.status).toBe(200);
      expect(await bytesOf(read)).toEqual(PNG);

      const download = await t.query((ctx) =>
        azure.getUrl(ctx, ticket.fileId, { download: true }),
      );
      const downloaded = await call(download!);
      expect(downloaded.status).toBe(200);
      const disposition = downloaded.headers.get("content-disposition") ?? "";
      expect(disposition.startsWith("attachment")).toBe(true);
      expect(disposition).toContain("live%20pixel.png");
    });

    test("an upload ticket cannot read the blob", async () => {
      const azure = client();
      const { ticket, put } = await upload(azure);
      expect(put.status).toBe(201);
      expect((await call(ticket.uploadUrl)).status).toBe(403);
      expect(await confirm(azure, ticket.fileId)).toMatchObject({ ok: true });
      expect((await call(ticket.uploadUrl)).status).toBe(403);
    });

    test("an upload ticket cannot overwrite a confirmed blob", async () => {
      const azure = client();
      const { ticket, url } = await ready(azure);
      const overwrite = await call(ticket.uploadUrl, {
        method: "PUT",
        headers: ticket.headers,
        body: "evil",
      });
      expect([403, 409]).toContain(overwrite.status);
      expect(await bytesOf(await call(url))).toEqual(PNG);
    });

    test("a read URL cannot write or delete", async () => {
      const azure = client();
      const { url } = await ready(azure);
      const put = await call(url, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob", "x-ms-version": SAS_VERSION },
        body: "evil",
      });
      expect(put.status).toBe(403);
      expect((await call(url, { method: "DELETE" })).status).toBe(403);
      expect(await bytesOf(await call(url))).toEqual(PNG);
    });

    test("a read URL for one blob cannot read another", async () => {
      const azure = client();
      const a = await ready(azure);
      const b = await ready(azure);
      const crossed = new URL(a.url);
      crossed.pathname = new URL(b.url).pathname;
      expect((await call(crossed)).status).toBe(403);
    });

    test("a tampered signature is refused", async () => {
      const azure = client();
      const { url } = await ready(azure);
      const tampered = new URL(url);
      const sig = tampered.searchParams.get("sig") ?? "";
      tampered.searchParams.set(
        "sig",
        (sig.startsWith("A") ? "B" : "A") + sig.slice(1),
      );
      expect((await call(tampered)).status).toBe(403);
    });

    test("an expired read URL is refused", async () => {
      // A one-second window makes the URL valid for under two seconds.
      const azure = client({ readWindowSeconds: 1 });
      const { ticket, put } = await upload(client());
      expect(put.status).toBe(201);
      expect(await confirm(azure, ticket.fileId)).toMatchObject({ ok: true });
      const url = await t.query((ctx) => azure.getUrl(ctx, ticket.fileId));
      await sleep(5000);
      expect((await call(url!)).status).toBe(403);
    });

    it.skipIf(!config || !config.endpoint!.startsWith("https:"))(
      "a plain http variant of an https SAS is not served",
      async () => {
        const azure = client();
        const { url } = await ready(azure);
        expect(new URL(url).searchParams.get("spr")).toBe("https");
        const insecure = new URL(url);
        insecure.protocol = "http:";
        const status = await call(insecure).then(
          (response) => response.status,
          () => 0,
        );
        expect(status >= 200 && status < 300).toBe(false);
      },
      TIMEOUT,
    );

    test("a different content type than reserved is rejected and the blob removed", async () => {
      const azure = client();
      const { ticket, put } = await upload(
        azure,
        PNG,
        {},
        { "content-type": "text/html" },
      );
      expect(put.status).toBe(201);
      expect((await confirm(azure, ticket.fileId)).ok).toBe(false);
      expect(await blobStatus(azure, ticket.fileId)).toBe(404);
    });

    test("bytes that are not the declared type are rejected and the blob removed", async () => {
      const azure = client();
      for (const body of [JPEG, "<svg onload=alert(1)>"]) {
        const { ticket, put } = await upload(azure, body);
        expect(put.status).toBe(201);
        expect(await confirm(azure, ticket.fileId)).toEqual({
          ok: false,
          reason: "The file content does not match its type",
        });
        expect(await blobStatus(azure, ticket.fileId)).toBe(404);
      }
    });

    test("an upload over maxBytes is rejected and the blob removed", async () => {
      const azure = client({ maxBytes: 10 });
      const { ticket, put } = await upload(azure);
      expect(put.status).toBe(201);
      expect((await confirm(azure, ticket.fileId)).ok).toBe(false);
      expect(await blobStatus(azure, ticket.fileId)).toBe(404);
    });

    test("a matching Content-MD5 is accepted and confirmed", async () => {
      const azure = client();
      const md5 = createHash("md5").update(PNG).digest("base64");
      const { ticket, put } = await upload(azure, PNG, { md5 });
      expect(put.status).toBe(201);
      expect(await confirm(azure, ticket.fileId)).toEqual({
        ok: true,
        size: PNG.length,
        contentType: "image/png",
      });
    });

    test("a wrong Content-MD5 makes Azure refuse the PUT", async () => {
      const azure = client();
      const { put } = await upload(azure, PNG, {
        md5: "AAAAAAAAAAAAAAAAAAAAAA==",
      });
      expect(put.status).toBe(400);
    });

    test("block uploads serve an immutable snapshot that later writes cannot change", async () => {
      const azure = client({ blockUploads: true });
      const ticket = await t.action((ctx) =>
        azure.generateUploadUrl(ctx, {
          contentType: "image/png",
          uploadedBy: "live-test",
          size: PNG.length,
        }),
      );
      created.push({ azure, fileId: ticket.fileId });
      const stage = new URL(ticket.uploadUrl);
      stage.searchParams.set("comp", "block");
      stage.searchParams.set("blockid", blockId(0));
      expect((await call(stage, { method: "PUT", body: PNG })).status).toBe(
        201,
      );
      expect((await call(ticket.uploadUrl)).status).toBe(403);
      expect(await confirm(azure, ticket.fileId)).toEqual({
        ok: true,
        size: PNG.length,
        contentType: "image/png",
      });
      const url = await t.query((ctx) => azure.getUrl(ctx, ticket.fileId));
      expect(new URL(url!).searchParams.has("snapshot")).toBe(true);
      expect(await bytesOf(await call(url!))).toEqual(PNG);

      // Whether Azure accepts this write is irrelevant: the served bytes must not move.
      await call(ticket.uploadUrl, {
        method: "PUT",
        headers: ticket.headers,
        body: "changed",
      });
      expect(await bytesOf(await call(url!))).toEqual(PNG);
    });

    test("read returns the bytes and a 206 for a range", async () => {
      const azure = client();
      const stored = await t.action((ctx) =>
        azure.store(ctx, {
          data: PNG,
          contentType: "image/png",
          uploadedBy: "live-test",
        }),
      );
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      created.push({ azure, fileId: stored.fileId });
      const whole = await t.action(async (ctx) => {
        const response = await azure.read(ctx, stored.fileId);
        return Array.from(new Uint8Array(await response!.arrayBuffer()));
      });
      expect(whole).toEqual(Array.from(PNG));
      const part = await t.action(async (ctx) => {
        const response = await azure.read(ctx, stored.fileId, {
          range: { start: 1, end: 3 },
        });
        return {
          status: response!.status,
          bytes: Array.from(new Uint8Array(await response!.arrayBuffer())),
        };
      });
      expect(part.status).toBe(206);
      expect(part.bytes).toEqual(Array.from(PNG.slice(1, 4)));
    });

    it.skipIf(!config || !copySource)(
      "storeFromUrl copies an https source",
      async () => {
        const azure = client();
        const stored = await t.action((ctx) =>
          azure.storeFromUrl(ctx, {
            sourceUrl: copySource!,
            contentType: "image/png",
            uploadedBy: "live-test",
          }),
        );
        expect(stored.ok).toBe(true);
        if (!stored.ok) return;
        created.push({ azure, fileId: stored.fileId });
        const url = await t.query((ctx) => azure.getUrl(ctx, stored.fileId));
        const read = await call(url!);
        expect(read.status).toBe(200);
        expect((await bytesOf(read)).length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    test("after a purge a previously valid read URL returns 404", async () => {
      const azure = client();
      const { ticket, url } = await ready(azure);
      expect((await call(url)).status).toBe(200);
      expect(await t.action((ctx) => azure.purge(ctx, ticket.fileId))).toBe(
        true,
      );
      expect((await call(url)).status).toBe(404);
    });

    if (entra) {
      const storedKey = (now: number) =>
        t.query((ctx) =>
          ctx.runQuery(component.lib.getUserDelegationKey, {
            accountName: config!.accountName!,
            now,
          }),
        );

      test("signs read URLs with the stored delegation key and never past its expiry", async () => {
        const azure = client();
        const key = await storedKey(Date.now());
        expect(key).not.toBeNull();
        const { url } = await ready(azure);
        const params = new URL(url).searchParams;
        expect(params.get("skoid") === key!.signedObjectId).toBe(true);
        expect(Date.parse(params.get("se")!)).toBeLessThanOrEqual(
          Date.parse(key!.signedExpiry),
        );
        expect((await call(url)).status).toBe(200);
      });

      test("an upload URL never outlives the delegation key", async () => {
        const azure = client();
        const key = await storedKey(Date.now());
        const { ticket, put } = await upload(azure);
        expect(put.status).toBe(201);
        const signedExpiry = new URL(ticket.uploadUrl).searchParams.get("se");
        expect(signedExpiry).not.toBeNull();
        expect(Date.parse(signedExpiry!)).toBeLessThanOrEqual(
          Date.parse(key!.signedExpiry),
        );
      });

      test("a forced refresh replaces the key and new SAS URLs still work", async () => {
        const azure = client();
        const before = await storedKey(Date.now());
        await t.action((ctx) => azure.refreshUserDelegationKey(ctx));
        const unchanged = await storedKey(Date.now());
        expect(unchanged!.keyValue === before!.keyValue).toBe(true);

        await sleep(1100);
        await t.action((ctx) =>
          azure.refreshUserDelegationKey(ctx, { force: true }),
        );
        const after = await storedKey(Date.now());
        expect(after!.keyValue === before!.keyValue).toBe(false);
        const { url } = await ready(azure);
        expect((await call(url)).status).toBe(200);
      });
    }
  });
}

defineLiveSuite("shared key", sharedKeyConfig);
defineLiveSuite("Microsoft Entra", entraConfig);
