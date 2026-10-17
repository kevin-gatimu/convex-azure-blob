#!/usr/bin/env node
// Prepares a local Azurite blob emulator for the example app: creates the container and sets a
// CORS rule so the browser can PUT uploads and read files. Safe to run repeatedly.
//
//   docker compose up -d azurite
//   npm run azurite:setup
//
// Environment: AZURITE_BLOB_PORT (10000), AZURE_BLOB_CONTAINER (uploads),
// CORS_ORIGINS (comma separated, http://localhost:5173).
// Note: CORS rules are account-wide, so this replaces any rules already set on that emulator.
import { createHmac } from "node:crypto";

// Azurite's published development account; the key is public and only works with the emulator.
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const VERSION = "2022-11-02";

const port = process.env.AZURITE_BLOB_PORT || "10000";
const container = process.env.AZURE_BLOB_CONTAINER || "uploads";
const origins = (process.env.CORS_ORIGINS || "http://localhost:5173").split(
  ",",
);
const endpoint = `http://127.0.0.1:${port}/${ACCOUNT}`;

/** A Shared Key request; Azurite's path-style URLs repeat the account in the canonical path. */
async function request({ method, path = "", query = {}, body }) {
  const url = new URL(`${endpoint}${path}`);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  const payload = body === undefined ? undefined : Buffer.from(body);
  const headers = {
    "x-ms-date": new Date().toUTCString(),
    "x-ms-version": VERSION,
  };
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  const canonicalQuery = [...url.searchParams.keys()]
    .sort()
    .map((key) => `\n${key.toLowerCase()}:${url.searchParams.get(key)}`)
    .join("");
  const stringToSign = [
    method,
    "",
    "",
    payload ? String(payload.length) : "",
    "",
    payload ? "application/xml" : "",
    "",
    "",
    "",
    "",
    "",
    "",
    `${canonicalHeaders}/${ACCOUNT}${url.pathname}${canonicalQuery}`,
  ].join("\n");
  const signature = createHmac("sha256", Buffer.from(KEY, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64");
  return await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(payload ? { "content-type": "application/xml" } : {}),
      authorization: `SharedKey ${ACCOUNT}:${signature}`,
    },
    body: payload,
  });
}

/** Azurite refuses connections for a moment after it starts, so retry for up to ~15 seconds. */
async function withRetry(attempt) {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const created = await withRetry(() =>
  request({
    method: "PUT",
    path: `/${container}`,
    query: { restype: "container" },
  }),
);
// 409: the container already exists.
if (!created.ok && created.status !== 409) {
  throw new Error(
    `Creating container failed: ${created.status} ${await created.text()}`,
  );
}

const cors =
  `<?xml version="1.0" encoding="utf-8"?><StorageServiceProperties><Cors><CorsRule>` +
  `<AllowedOrigins>${origins.join(",")}</AllowedOrigins>` +
  `<AllowedMethods>PUT,GET,HEAD,OPTIONS</AllowedMethods>` +
  `<AllowedHeaders>x-ms-blob-type,content-type,x-ms-version,x-ms-client-request-id,x-ms-date</AllowedHeaders>` +
  `<ExposedHeaders>etag,content-length,content-type,x-ms-request-id</ExposedHeaders>` +
  `<MaxAgeInSeconds>3600</MaxAgeInSeconds></CorsRule></Cors></StorageServiceProperties>`;
const properties = await request({
  method: "PUT",
  query: { restype: "service", comp: "properties" },
  body: cors,
});
if (!properties.ok) {
  throw new Error(
    `Setting CORS failed: ${properties.status} ${await properties.text()}`,
  );
}

console.log(
  `Azurite ready at ${endpoint}: container "${container}", CORS for ${origins.join(", ")}`,
);
console.log(`Set these on your Convex deployment (npx convex env set NAME VALUE):
  AZURE_BLOB_ACCOUNT=${ACCOUNT}
  AZURE_BLOB_KEY=${KEY}
  AZURE_BLOB_CONTAINER=${container}
  AZURE_BLOB_ENDPOINT=${endpoint}`);
