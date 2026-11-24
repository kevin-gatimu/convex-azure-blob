# Convex Azure Blob Storage

[![Convex Component](https://www.convex.dev/components/badge/convex-azure-blob-storage)](https://www.convex.dev/components/convex-azure-blob-storage)
[![npm version](https://img.shields.io/npm/v/convex-azure-blob-storage.svg)](https://www.npmjs.com/package/convex-azure-blob-storage)
[![Test and lint](https://github.com/kevin-gatimu/convex-azure-blob-storage/actions/workflows/test.yml/badge.svg)](https://github.com/kevin-gatimu/convex-azure-blob-storage/actions/workflows/test.yml)

<!-- START: Include on https://convex.dev/components -->

Store files in
[Azure Blob Storage](https://learn.microsoft.com/azure/storage/blobs/storage-blobs-introduction)
and keep their metadata in Convex. Browsers upload straight to Azure with a
short-lived, single-blob SAS URL, so file bytes never pass through your Convex
functions.

```ts
// convex/files.ts
export const azure = new AzureBlob(components.azureBlobStorage);

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
[File it here](https://github.com/kevin-gatimu/convex-azure-blob-storage/issues).

## Prerequisites

### An Azure storage account

Create a storage account and a **private** container (no anonymous access), copy
an access key (or use
[Microsoft Entra](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/entra.md)),
and add a CORS rule for your app's origins. The steps, the CORS table and the
Azure CLI command are in
[Azure setup](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/azure-setup.md#an-azure-storage-account).

For local development, use
[Azurite](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/testing.md#local-development-with-azurite)
instead. Once the variables are set,
[check your setup](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/azure-setup.md#checking-your-setup)
to catch a wrong key, a missing role, a missing container, or a CORS rule that
blocks uploads.

### A Convex app

Any Convex project with `convex@1.46` or later. Run `npm create convex` to start
one.

## Installation

```sh
npm install convex-azure-blob-storage
```

Install the component in your app's `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import azureBlobStorage from "convex-azure-blob-storage/convex.config.js";

const app = defineApp();
app.use(azureBlobStorage);

export default app;
```

### Environment variables

Set these on your Convex deployment with `npx convex env set`, or pass the same
values as `config` to the constructor. Pick **one** way to sign: a shared
account key, or Microsoft Entra. If `AZURE_BLOB_KEY` is set, the shared key is
used and the Entra variables are ignored.

#### Always needed

| Variable                       | Required | Meaning                                                                                                        |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `AZURE_BLOB_ACCOUNT`           | yes      | Storage account name.                                                                                          |
| `AZURE_BLOB_CONTAINER`         | yes      | Container that new uploads go to.                                                                              |
| `AZURE_BLOB_ENDPOINT`          | yes      | Account URL as the **browser** sees it, e.g. `https://<account>.blob.core.windows.net`.                        |
| `AZURE_BLOB_INTERNAL_ENDPOINT` | no       | Account URL **Convex** uses for its own requests, when it differs (self-hosted Convex in Docker, for example). |
| `AZURE_BLOB_PUBLIC_BASE_URL`   | no       | Serve reads as `<base>/<blob name>` without a token: a CDN, or a container with public read access.            |

#### Shared key

The account must allow shared key access.

| Variable         | Required | Meaning                                                      |
| ---------------- | -------- | ------------------------------------------------------------ |
| `AZURE_BLOB_KEY` | yes      | Base64 account key, from the account's **Access keys** page. |

#### Microsoft Entra

Works when shared key access is disabled. Setup steps are in
[Microsoft Entra user-delegation SAS](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/entra.md).

| Variable                    | Required | Meaning                                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `AZURE_BLOB_TENANT_ID`      | yes      | Directory (tenant) ID.                                                                    |
| `AZURE_BLOB_CLIENT_ID`      | yes      | Application (client) ID of the app registration.                                          |
| `AZURE_BLOB_CLIENT_SECRET`  | yes      | Client secret of the app registration.                                                    |
| `AZURE_BLOB_KEY`            | no       | Must be unset, or the shared key is used instead.                                         |
| `AZURE_BLOB_AUTHORITY_HOST` | no       | Authority base URL for sovereign clouds; defaults to `https://login.microsoftonline.com`. |

Entra mode also needs the hourly `refreshUserDelegationKey` cron; see
[Required crons](#required-crons).

With a shared key:

```sh
npx convex env set AZURE_BLOB_ACCOUNT mystorageaccount
npx convex env set AZURE_BLOB_CONTAINER uploads
npx convex env set AZURE_BLOB_ENDPOINT https://mystorageaccount.blob.core.windows.net
npx convex env set AZURE_BLOB_KEY   # prompts, so the key stays out of shell history
```

With Microsoft Entra:

```sh
npx convex env set AZURE_BLOB_ACCOUNT mystorageaccount
npx convex env set AZURE_BLOB_CONTAINER uploads
npx convex env set AZURE_BLOB_ENDPOINT https://mystorageaccount.blob.core.windows.net
npx convex env set AZURE_BLOB_TENANT_ID '<directory-tenant-id>'
npx convex env set AZURE_BLOB_CLIENT_ID '<application-client-id>'
npx convex env set AZURE_BLOB_CLIENT_SECRET   # prompts
```

[`.env.example`](./.env.example) lists the same variables, grouped the same way.

### Required crons

The component does some work on a schedule, so add these jobs to your app's
`convex/crons.ts`. Without them nothing fails at once, but problems build up:

| Job                        | Schedule     | What it does                                                                                   | Needed when                        |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| `sweep`                    | hourly       | Deletes blobs of uploads that were never confirmed, and retries deletes that failed            | always                             |
| `refreshUserDelegationKey` | every hour   | Renews the 24-hour signing key; without it, uploads and signed reads stop when the key expires | you use Microsoft Entra            |
| `scanMalware`              | every minute | Collects Defender scan verdicts so scanned files become ready                                  | you set `requireMalwareScan: true` |

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly("sweep azure blobs", { minuteUTC: 17 }, internal.files.sweep, {});
// Microsoft Entra only. Hourly, not daily: a daily run leaves minutes with no valid key.
crons.interval(
  "refresh Azure Blob user delegation key",
  { hours: 1 },
  internal.files.refreshUserDelegationKey,
  {},
);
// Only with requireMalwareScan.
crons.interval(
  "check malware scan results",
  { minutes: 1 },
  internal.files.scanMalware,
  {},
);
export default crons;
```

`sweep` and `refreshUserDelegationKey` are internal actions you define in
`convex/files.ts`, shown in
[Deleting files and the sweep](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/deleting-and-sweep.md).
`scanMalware` is returned by `clientApi`, shown in
[Defender for Storage malware scan gate](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/malware-scanning.md).
With Microsoft Entra, also run `refreshUserDelegationKey` once after deploying,
so a key is cached before the first upload.

## Uploading files

Create a client for the component and export the upload functions:

```ts
// convex/files.ts
import { AzureBlob } from "convex-azure-blob-storage";
import { components, internal } from "./_generated/api";

export const azure = new AzureBlob(components.azureBlobStorage, {
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
import { useUploadFile } from "convex-azure-blob-storage/react";
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

`getUrl` returns `null` unless the file is `ready` and not archived (including
while rehydrating). Read URLs:

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
`azure.urlForFile(file, options, ctx)` to skip a second lookup. The query
context is required for Entra authentication so the cached delegation key can be
read without a network request; it is optional with account-key authentication.

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

The sweep cron that removes abandoned uploads and retries failed deletes, its
action, and sweep tuning are in
[Deleting files and the sweep](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/deleting-and-sweep.md).

## Security model

- **One blob, one permission, short expiry.** Upload URLs allow only create
  (`c`) on a single new blob name for `uploadTtlSeconds` (default 300). They
  cannot overwrite a blob after it is confirmed, read it, or touch any other
  blob. Opt-in block uploads instead use `w` on their staging blob; confirmed
  reads are pinned to a verified immutable snapshot. Neither browser ticket
  grants read or delete access. Convex's own requests have the permissions
  needed for their server-side operation.
- **HTTPS only.** For `https://` endpoints, every token is signed with
  `spr=https`, so it is refused over plain HTTP.
- **Server-generated blob names.** Names are a random UUID, an optional fixed
  prefix and an extension from the allow-list. Callers never choose a path.
- **Checked before serving.** Size, content type and file signature are verified
  from the stored blob, against what was reserved, before `getUrl` returns
  anything. A SAS cannot cap the upload size, so an oversized blob exists until
  confirm (or the sweep) deletes it.
- **Active content.** Executable types such as HTML and SVG need care; see the
  warning under
  [Allowed types and sizes](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/uploads.md#allowed-types-and-sizes).
- **Malware scanning is opt-in.** Use `requireMalwareScan` with Defender for
  Storage to keep confirmed files unservable until a clean scan result arrives.
  Without it, files are not checked for malware. See
  [Defender for Storage](https://learn.microsoft.com/azure/defender-for-cloud/defender-for-storage-introduction)
  and the
  [scan-gate guide](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/malware-scanning.md).
  SVG is not in the default allow-list, because it can carry script.
- **Signing secrets stay server-side.** The account key is read from deployment
  environment variables and is never stored in component tables, passed as a
  function argument, returned or logged. In Entra mode, client credentials stay
  in deployment environment variables, while the short-lived delegation key is
  stored in the component table so queries can sign URLs without network calls.
  Never return or log that key. Use Azure's **Revoke User Delegation Keys**
  operation to invalidate it and outstanding delegation SAS URLs.
- **Read URLs are bearer links** for one to two `readWindowSeconds` windows.
  Shorten the window for sensitive files, or serve them through your own HTTP
  action.
- **Authorization is yours.** `uploadedBy` is an opaque string. The component
  does not check it, except that `clientApi` only lets the uploader confirm.

## Guides

| Guide                                                                                                                          | Covers                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Azure setup](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/azure-setup.md)                         | the storage account, CORS, and `checkSetup`                                        |
| [Microsoft Entra](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/entra.md)                           | sign with an app registration instead of a key                                     |
| [Uploads in depth](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/uploads.md)                        | large and resumable uploads, MD5, custom upload functions, allowed types and sizes |
| [Event Grid confirmation](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/event-grid.md)              | confirm uploads from Azure instead of the browser                                  |
| [Malware scanning](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/malware-scanning.md)               | hold files until Defender for Storage clears them                                  |
| [Access tiers](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/access-tiers.md)                       | hot, cool, cold and archive blobs                                                  |
| [Reading and listing](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/reading-and-listing.md)         | CDN, reads from actions, listing and metadata                                      |
| [Deleting and the sweep](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/deleting-and-sweep.md)       | retention, retries and sweep tuning                                                |
| [Storing from actions](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/storing-from-actions.md)       | upload bytes you already have                                                      |
| [Encryption scopes](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/encryption-scopes.md)             | encrypt new blobs with an Azure scope                                              |
| [Containers and prefixes](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/containers-and-prefixes.md) | several containers or folders                                                      |
| [Testing](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/testing.md)                                 | Azurite and testing your app                                                       |
| [Blob index tags](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/blob-index-tags.md)                 | tag blobs for lifecycle rules and search                                           |

## API reference

The `AzureBlob` class, its methods, the React hook and the lower-level exports
are listed in the
[API reference](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/api.md).

## Example app

[`example/`](./example) demonstrates the full browser-to-Azure flow: Convex
issues file-scoped SAS URLs, Azure receives the bytes directly, and Convex
publishes verified metadata in real time. It supports choosing one file or
multiple files, an upload queue with per-file progress and errors, pause/resume
in the current tab, viewing files in a new tab, downloads, deletion, and a sweep
cron.

See the [example's illustrated walkthrough](./example/README.md) for upload
progress, pause/resume, and the View file and Download file actions.

Accepted types are JPEG, PNG, WebP, GIF, AVIF, PDF, ZIP, MP4, WebM, and MP3.
Images have previews; other files have download cards. The demo opts into block
uploads and uses Azure's block-blob ceiling rather than an artificial 5 MB
limit. For production, choose a sensible `maxBytes` and quota for your costs and
users. Signature validation remains enabled; it is not malware scanning.

**View file** opens the signed read URL in a separate tab. Browsers can display
images, PDFs, audio, and video they support; archives and unsupported formats
may download instead. **Download file** uses a separate attachment URL.

The example has no sign-in: anonymous visitors share a demo identity and file
library. Do not upload sensitive files. Replace its identity function with
authenticated authorization before deploying for real users.

To run against Azurite, open separate terminals from the repository root:

```sh
npm install
docker compose up -d azurite
npm run azurite:setup          # container + CORS for http://localhost:5173
npm run dev                    # first run sets up a Convex deployment
# set the four AZURE_BLOB_* variables the setup script printed, then:
npm run dev:frontend
```

The npm scripts use Windows-compatible quoting. If the frontend says Convex is
disconnected, keep `npm run dev` running and verify `VITE_CONVEX_URL` points to
that deployment. Restart Vite after changing its environment configuration.

For live Azure, see
[Running the example against live Azure](https://github.com/kevin-gatimu/convex-azure-blob-storage/blob/main/docs/testing.md#running-the-example-against-live-azure).

## License

[Apache-2.0](./LICENSE)
