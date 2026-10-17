# Convex Azure Blob Storage

[![npm version](https://badge.fury.io/js/convex-azure-blob.svg)](https://badge.fury.io/js/convex-azure-blob)
[![Test and lint](https://github.com/kevin-gatimu/convex-azure-blob/actions/workflows/test.yml/badge.svg)](https://github.com/kevin-gatimu/convex-azure-blob/actions/workflows/test.yml)

<!-- START: Include on https://convex.dev/components -->

Store files in
[Azure Blob Storage](https://learn.microsoft.com/azure/storage/blobs/storage-blobs-introduction)
and keep their metadata in Convex. Browsers upload straight to Azure with a
short-lived, single-blob SAS URL, so file bytes never pass through your Convex
functions.

```ts
// convex/files.ts
export const azure = new AzureBlob(components.azureBlob);

export const { generateUploadUrl, confirmUpload } = azure.clientApi({
  identify: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null,
});
```

```tsx
// In React
const { upload, progress } = useUploadFile(api.files);
const fileId = await upload(file);
```

- **No Azure SDK and no `"use node"`.** SAS tokens are signed with Web Crypto,
  so everything runs in the default Convex runtime.
- **Safe uploads by default.** Upload URLs can only _create_ one server-named
  blob, for five minutes. Convex checks each upload's size, content type and
  leading bytes (its file signature) before the file is served. A rejected
  upload is deleted.
- **Reactive metadata.** The component's `files` table holds each file's status,
  size, name, uploader and your own metadata. Queries that read it update live.
- **Served from Azure.** Read URLs are cacheable and signed per time window.
  They can force a download under the original file name, or set
  `Cache-Control`. A CDN or public container works too.
- **Cleans up after itself.** Deletion is transactional with your data, and a
  sweep removes abandoned uploads and retries failed deletes.
- **Your rules.** The component never decides who may upload, read or delete.
  Your functions do, and they pass the uploader as an opaque id.

Found a bug or want a feature?
[File it here](https://github.com/kevin-gatimu/convex-azure-blob/issues).

## Prerequisites

### An Azure storage account

1. Create a storage account and a **private** container (no anonymous access).
   [Azure portal guide](https://learn.microsoft.com/azure/storage/blobs/storage-quickstart-blobs-portal).
2. Copy an access key from **Security + networking → Access keys**.
3. Add a CORS rule for your app's origins under **Settings → Resource sharing
   (CORS) → Blob service**:

   | Allowed origins          | Allowed methods           | Allowed headers                                                                 | Exposed headers                      | Max age |
   | ------------------------ | ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ | ------- |
   | `https://your.app` (etc) | `GET, HEAD, PUT, OPTIONS` | `x-ms-blob-type, content-type, x-ms-version, x-ms-client-request-id, x-ms-date` | `etag, content-length, content-type` | `3600`  |

   Or with the Azure CLI:

   ```sh
   az storage cors add --services b --account-name <account> \
     --origins https://your.app --methods GET HEAD PUT OPTIONS \
     --allowed-headers 'x-ms-blob-type,content-type,x-ms-version,x-ms-client-request-id,x-ms-date' \
     --exposed-headers 'etag,content-length,content-type' --max-age 3600
   ```

For local development, use [Azurite](#local-development-with-azurite) instead.

### A Convex app

Any Convex project with `convex@1.46` or later. Run `npm create convex` to start
one.

## Installation

```sh
npm install convex-azure-blob
```

Install the component in your app's `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import azureBlob from "convex-azure-blob/convex.config.js";

const app = defineApp();
app.use(azureBlob);

export default app;
```

Set the storage account details on your deployment:

```sh
npx convex env set AZURE_BLOB_ACCOUNT mystorageaccount
npx convex env set AZURE_BLOB_KEY 'base64-account-key=='
npx convex env set AZURE_BLOB_CONTAINER uploads
npx convex env set AZURE_BLOB_ENDPOINT https://mystorageaccount.blob.core.windows.net
```

| Variable                       | Required | Meaning                                                                                                        |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `AZURE_BLOB_ACCOUNT`           | yes      | Storage account name.                                                                                          |
| `AZURE_BLOB_KEY`               | yes      | Base64 account key. It is only used to sign tokens and never leaves your deployment.                           |
| `AZURE_BLOB_CONTAINER`         | yes      | Container that new uploads go to.                                                                              |
| `AZURE_BLOB_ENDPOINT`          | yes      | Account URL as the **browser** sees it, e.g. `https://<account>.blob.core.windows.net`.                        |
| `AZURE_BLOB_INTERNAL_ENDPOINT` | no       | Account URL **Convex** uses for its own requests, when it differs (self-hosted Convex in Docker, for example). |
| `AZURE_BLOB_PUBLIC_BASE_URL`   | no       | Serve reads as `<base>/<blob name>` without a token: a CDN, or a container with public read access.            |

You can pass the same values as `config` to the constructor instead.

## Uploading files

Create a client for the component and export the upload functions:

```ts
// convex/files.ts
import { AzureBlob } from "convex-azure-blob";
import { components, internal } from "./_generated/api";

export const azure = new AzureBlob(components.azureBlob, {
  maxBytes: 5 * 1024 * 1024, // default 10 MiB
});

const uploadApi: ReturnType<AzureBlob["clientApi"]> = azure.clientApi({
  // Who is uploading? Return null to refuse. This runs in both functions, and
  // only the uploader can confirm their own upload.
  identify: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null,

  // Optional: more checks before a URL is issued. Throw to refuse.
  checkUpload: async (ctx, { uploadedBy, contentType, size }) => {
    // e.g. enforce a quota with ctx.db
  },

  // Optional: an internal mutation accepting { fileId }.
  onUpload: internal.posts.attachImage,
});
export const { generateUploadUrl, confirmUpload } = uploadApi;
```

`onUpload` is committed in the same transaction as the file becoming ready.
Inside that internal mutation, use `await azure.getFile(ctx, fileId)` to read
the confirmed file, then update your app's tables. If the mutation throws, both
changes roll back and confirmation can be retried. Concurrent or repeated
confirmations commit the attachment only once. As with any Convex mutation, the
handler may be re-executed on transaction retries; do not perform external side
effects in it. Schedule actions for email, webhooks, or other network work.

The typed `uploadApi` variable avoids circular inference when the callback is
referenced through your generated `internal` API.

Then upload from React:

```tsx
import { useUploadFile } from "convex-azure-blob/react";
import { api } from "../convex/_generated/api";

function UploadButton() {
  const { upload, progress, isUploading, error, cancel } = useUploadFile(
    api.files,
  );
  return (
    <>
      <input
        type="file"
        accept="image/*"
        disabled={isUploading}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await upload(file); // resolves with the fileId
        }}
      />
      {isUploading && <progress value={progress ?? 0} max={1} />}
      {error && <p>{error.message}</p>}
    </>
  );
}
```

`useUploadFile` calls `generateUploadUrl`, PUTs the file to Azure with progress
events, then calls `confirmUpload`. If confirmation fails, `upload` rejects with
the reason, for example "The file is too large".

### Writing your own upload functions

`clientApi` is a shortcut. When the upload belongs to something in your schema
(a post, a profile), write the functions yourself and check permissions first:

```ts
export const generateCoverUploadUrl = mutation({
  args: { postId: v.id("posts"), contentType: v.string() },
  handler: async (ctx, { postId, contentType }) => {
    const userId = await requireUser(ctx);
    await requireCanEdit(ctx, userId, postId);
    return await azure.generateUploadUrl(ctx, {
      contentType,
      uploadedBy: userId,
      fileName: "cover",
      metadata: { postId },
    });
    // => { fileId, uploadUrl, headers }
  },
});

export const setCover = action({
  args: { postId: v.id("posts"), fileId: v.string() },
  handler: async (ctx, { postId, fileId }) => {
    const userId = await requireUserInAction(ctx);
    const file = await azure.getFile(ctx, fileId);
    if (file?.uploadedBy !== userId) throw new Error("Not your upload");
    const result = await azure.confirmUpload(ctx, fileId);
    if (!result.ok) throw new Error(result.reason);
    await ctx.runMutation(internal.posts.saveCover, { postId, fileId });
  },
});
```

`useUploadFile` works with these too, as long as the mutation takes
`contentType` and returns the `{ fileId, uploadUrl, headers }` ticket. Pass any
extra arguments as the second argument of `upload`: `upload(file, { postId })`.

Without React, use `uploadToAzure(uploadUrl, file, { headers, onProgress })`
from `convex-azure-blob/react`, or any HTTP client: `PUT` the bytes to
`uploadUrl` with the returned `headers`.

### Allowed types and sizes

By default the allow-list is JPEG, PNG, WebP, GIF and AVIF. Change it with
`allowedContentTypes`, which maps each content type to the extension of the
generated blob name:

```ts
new AzureBlob(components.azureBlob, {
  allowedContentTypes: {
    "application/pdf": "pdf",
    "image/png": "png",
    "text/csv": "csv",
  },
  maxBytes: 25 * 1024 * 1024,
});
```

At confirm, the component reads the blob's real size and content type from
Azure. It also reads the first 64 bytes and checks them against the file
signature for JPEG, PNG, GIF, WebP, AVIF, HEIC, PDF, ZIP, MP4, WebM and MP3
(`SNIFFABLE_CONTENT_TYPES`). Types without a known signature, such as CSV, skip
that byte check. Turn it off with `verifyContent: false`.

## Serving files

```ts
export const getPost = query({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get("posts", postId);
    if (!post) return null;
    return {
      ...post,
      coverUrl: post.coverFileId
        ? await azure.getUrl(ctx, post.coverFileId)
        : null,
    };
  },
});
```

`getUrl` returns `null` unless the file is `ready`. Read URLs:

- grant read (`r`) on that one blob only;
- are signed per `readWindowSeconds` window (default one hour) and stay valid
  for two windows, so every caller in a window gets the same URL. Query results
  stay cacheable and browsers can cache the image;
- are **bearer links**: anyone holding one can read the blob until it expires.

Options:

```ts
await azure.getUrl(ctx, fileId, { download: true }); // download under the stored file name
await azure.getUrl(ctx, fileId, { download: "invoice-42.pdf" }); // or under this name
await azure.getUrl(ctx, fileId, { cacheControl: "private, max-age=3600" });
```

If you already loaded the file (from `list` or `getFile`), call
`azure.urlForFile(file, options)` to skip a second lookup.

### Through a CDN or public container

Set `AZURE_BLOB_PUBLIC_BASE_URL` (for example `https://cdn.example.com/uploads`)
and `getUrl` returns `<base>/<blob name>` with no token. That makes URLs
permanent and easy to cache at the edge. Download URLs are still signed, since
they need a `Content-Disposition` override.

## Listing files and metadata

```ts
export const myFiles = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUser(ctx);
    return await azure.list(ctx, { uploadedBy: userId, paginationOpts });
  },
});
```

`list` returns ready files, newest first, as a standard pagination result. Each
file has `fileId`, `container`, `blobName`, `contentType`, `size`, `maxBytes`,
`uploadedBy`, `fileName`, `metadata`, `status`, `createdAt` and
`uploadExpiresAt`.

Set a display name and string metadata at upload (`fileName`, `metadata`), or
later:

```ts
await azure.updateFile(ctx, fileId, { metadata: { alt: "A red bicycle" } });
```

Metadata is limited to 32 keys with values up to 1,024 characters. File names
are limited to 255 characters. The file name is never used in the blob path.

## Deleting files

Stop serving the file in the same mutation that removes your reference to it,
then delete the blob from an action:

```ts
export const deletePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await requireOwnPost(ctx, postId);
    await ctx.db.delete("posts", postId);
    if (post.coverFileId) {
      await azure.markForDeletion(ctx, post.coverFileId); // getUrl now returns null
      await ctx.scheduler.runAfter(0, internal.files.purge, {
        fileId: post.coverFileId,
      });
    }
  },
});

export const purge = internalAction({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => await azure.purge(ctx, fileId),
});
```

Add a cron as a safety net. It deletes uploads that were never confirmed (after
an hour by default) and retries any delete that failed:

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly("sweep azure blobs", { minuteUTC: 17 }, internal.files.sweep, {});
export default crons;

// convex/files.ts
export const sweep = internalAction({
  args: {},
  handler: async (ctx) => await azure.sweep(ctx),
});
```

`azure.delete` is an alias of `purge`. After a delete, the row stays in the
`deleting` state until the file's recorded `uploadExpiresAt` plus a five-minute
clock-skew allowance, because that URL could otherwise re-create the blob. A
later sweep removes it. Changing client TTL settings does not shorten this
retention. Sweep atomically claims stale pending uploads before deleting them,
so a confirmation that commits first is not swept.

## Storing files from actions

Upload bytes you already have (an import, a generated PDF, a migration from
Convex file storage):

```ts
export const importAvatar = internalAction({
  args: { url: v.string(), userId: v.string() },
  handler: async (ctx, { url, userId }) => {
    const response = await fetch(url);
    const result = await azure.store(ctx, {
      data: await response.blob(), // Blob, ArrayBuffer or Uint8Array
      contentType: response.headers.get("content-type") ?? "",
      uploadedBy: userId,
      fileName: "avatar",
    });
    if (!result.ok) throw new Error(result.reason);
    return result.fileId;
  },
});
```

`store` runs the same checks as a browser upload.

## Several containers or folders

Create one client per container or folder. Each file remembers its container, so
reads and deletes go to the right place:

```ts
export const avatars = new AzureBlob(components.azureBlob, {
  pathPrefix: "avatars", // blobs are named avatars/<uuid>.<ext>
  maxBytes: 1024 * 1024,
});

export const documents = new AzureBlob(components.azureBlob, {
  config: { container: "documents" },
  allowedContentTypes: { "application/pdf": "pdf" },
});
```

## Security model

- **One blob, one permission, short expiry.** Upload URLs allow only create
  (`c`) on a single new blob name for `uploadTtlSeconds` (default 300). They
  cannot overwrite a blob after it is confirmed, read it, or touch any other
  blob. Convex's own requests use one-minute `r` or `d` tokens.
- **HTTPS only.** For `https://` endpoints, every token is signed with
  `spr=https`, so it is refused over plain HTTP.
- **Server-generated blob names.** Names are a random UUID, an optional fixed
  prefix and an extension from the allow-list. Callers never choose a path.
- **Checked before serving.** Size, content type and file signature are verified
  from the stored blob, against what was reserved, before `getUrl` returns
  anything. A SAS cannot cap the upload size, so an oversized blob exists until
  confirm (or the sweep) deletes it.
- **Not checked:** what the bytes depict, and malware. If you accept arbitrary
  documents, add scanning (for example
  [Defender for Storage](https://learn.microsoft.com/azure/defender-for-cloud/defender-for-storage-introduction)).
  SVG is not in the default allow-list, because it can carry script.
- **The account key stays in your deployment.** It is read from environment
  variables in your functions. It is never stored in component tables, passed as
  a function argument, returned or logged. Rotating the key invalidates every
  outstanding URL immediately.
- **Read URLs are bearer links** for one to two `readWindowSeconds` windows.
  Shorten the window for sensitive files, or serve them through your own HTTP
  action.
- **Authorization is yours.** `uploadedBy` is an opaque string. The component
  does not check it, except that `clientApi` only lets the uploader confirm.

## Local development with Azurite

[Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)
emulates Blob Storage and validates SAS signatures the way Azure does.

```sh
docker run -d -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
  azurite-blob --blobHost 0.0.0.0 --loose
```

Create a container and a CORS rule for your dev server. This repository has a
script for that, `scripts/azurite-setup.mjs`. Then point Convex at it:

```sh
npx convex env set AZURE_BLOB_ACCOUNT devstoreaccount1
npx convex env set AZURE_BLOB_KEY 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
npx convex env set AZURE_BLOB_CONTAINER uploads
npx convex env set AZURE_BLOB_ENDPOINT http://127.0.0.1:10000/devstoreaccount1
```

That key is Azurite's published development key. It is not a secret and only
works with the emulator. A cloud Convex deployment cannot reach `127.0.0.1`, so
choose a local deployment when `npx convex dev` asks, or expose Azurite through
a tunnel.

## Testing your app

Register the component with
[convex-test](https://docs.convex.dev/testing/convex-test) and stub `fetch` for
the Azure calls:

```ts
import azureBlobTest from "convex-azure-blob/test";
import { convexTest } from "convex-test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function initConvexTest() {
  const t = convexTest(schema, modules);
  azureBlobTest.register(t); // pass a name if you installed it under another one
  return t;
}
```

See [`example/convex/photos.test.ts`](./example/convex/photos.test.ts) for a
complete test with Azure stubbed.

## API reference

### `new AzureBlob(component, options?)`

| Option                | Default                         | Meaning                                                                             |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `config`              | env vars                        | `{ accountName, accountKey, container, endpoint, internalEndpoint, publicBaseUrl }` |
| `allowedContentTypes` | JPEG/PNG/WebP/GIF/AVIF          | Content type → blob-name extension.                                                 |
| `maxBytes`            | 10 MiB                          | Size ceiling. Callers can ask for less, never more.                                 |
| `pathPrefix`          | none                            | Virtual folder for new blobs, e.g. `"users/avatars"`.                               |
| `uploadTtlSeconds`    | 300                             | Lifetime of upload URLs.                                                            |
| `readWindowSeconds`   | 3600                            | Signing window for read URLs. Each URL is valid for one to two windows.             |
| `verifyContent`       | `true`                          | Check leading bytes against the file signature at confirm.                          |
| `httpsOnly`           | `true` for `https://` endpoints | Sign tokens with `spr=https`.                                                       |

### Methods

The `ctx` type each method needs is the smallest that works, so you can call
query methods from mutations and actions too.

| Method                                                                                        | Call from    | Returns                                                      |
| --------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `generateUploadUrl(ctx, { contentType, uploadedBy, maxBytes?, size?, fileName?, metadata? })` | mutation     | `{ fileId, uploadUrl, headers }`                             |
| `confirmUpload(ctx, fileId, onUpload?)`                                                       | action       | `{ ok: true, size, contentType }` or `{ ok: false, reason }` |
| `getFile(ctx, fileId)`                                                                        | query        | `FileDoc` or `null`                                          |
| `getUrl(ctx, fileId, { download?, cacheControl? })`                                           | query        | URL or `null`                                                |
| `urlForFile(file, { download?, cacheControl? })`                                              | anywhere     | URL or `null`                                                |
| `list(ctx, { uploadedBy?, paginationOpts })`                                                  | query        | `PaginationResult<FileDoc>`                                  |
| `updateFile(ctx, fileId, { fileName?, metadata? })`                                           | mutation     | `boolean`                                                    |
| `markForDeletion(ctx, fileId)`                                                                | mutation     | `boolean`                                                    |
| `purge(ctx, fileId)` / `delete(ctx, fileId)`                                                  | action       | `boolean`                                                    |
| `sweep(ctx, { pendingOlderThanMs?, limit? })`                                                 | action       | number of blobs removed                                      |
| `store(ctx, { data, contentType, uploadedBy, maxBytes?, fileName?, metadata? })`              | action       | `{ ok: true, fileId }` or `{ ok: false, reason }`            |
| `clientApi({ identify, checkUpload?, onUpload? })`                                            | module scope | `{ generateUploadUrl, confirmUpload }` public functions      |

### `convex-azure-blob/react`

- `useUploadFile(api)` returns
  `{ upload, cancel, progress, isUploading, error }`. `api` is any object with
  `generateUploadUrl` and `confirmUpload` function references.
- `uploadToAzure(uploadUrl, file, { headers?, onProgress?, signal? })` is the
  same upload without React.
- `UploadError` is thrown for failed PUTs (with `status`) and rejected
  confirmations.
- Starting another upload cancels the previous one. Cancellation also applies
  while waiting for an upload ticket, and unmounting aborts the active PUT. A
  confirmation already sent to the server cannot be undone by cancellation.

### Lower-level exports

`signBlobSas`, `blobStringToSign`, `attachmentDisposition`, `sniffContentType`,
`SNIFFABLE_CONTENT_TYPES`, `resolveConfig` and `SAS_VERSION`, for advanced use
and your own tests.

<!-- END: Include on https://convex.dev/components -->

## Example app

[`example/`](./example) is a small photo gallery. It has uploads with progress,
the content check, downloads, deletion and a sweep cron. To run it against
Azurite:

```sh
npm install
docker compose up -d azurite
npm run azurite:setup          # container + CORS for http://localhost:5173
npm run dev                    # first run sets up a Convex deployment
# set the four AZURE_BLOB_* variables the setup script printed, then:
npm run dev:frontend
```

## Roadmap

Azure features that could come next. Contributions welcome:

- **User delegation SAS** (Microsoft Entra ID instead of the account key).
- **Large files with block uploads** (`Put Block` / `Put Block List`) and
  resumable uploads.
- **Access tiers** (Hot, Cool, Cold, Archive) per file, and lifecycle hints.
- **Blob index tags** for server-side search across files.
- **Copy from URL** (`Put Blob From URL`) for imports that skip Convex.
- **Event Grid** `BlobCreated` webhooks to confirm uploads without a client
  round trip.
- **Stored access policies**, to revoke outstanding URLs without rotating the
  key.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE)
