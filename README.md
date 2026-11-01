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

   **For this example:** use the exact origin `http://localhost:5173`, without a
   trailing slash. In the Azure portal, select the **Blob service** tab, fill in
   **Allowed headers** as well as the origin and methods, and select **Save**.
   Adding just the origin is not enough: a rule can allow ordinary `GET` and
   headerless `PUT` requests while rejecting the browser's upload preflight.
   `content-type` and `x-ms-version` must be allowed for block uploads.

   If an upload reports a network/CORS error, confirm these fields on the same
   rule:

   | Field           | Local example value                                                             |
   | --------------- | ------------------------------------------------------------------------------- |
   | Allowed origins | `http://localhost:5173`                                                         |
   | Allowed methods | `GET, HEAD, PUT, OPTIONS`                                                       |
   | Allowed headers | `content-type, x-ms-version, x-ms-blob-type, x-ms-client-request-id, x-ms-date` |
   | Exposed headers | `etag, content-length, content-type`                                            |
   | Max age         | `3600`                                                                          |

   RBAC permissions do not replace CORS. After saving, resume the failed upload.
   Preserve any existing CORS rules for other applications.

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

| Variable                       | Required      | Meaning                                                                                                        |
| ------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `AZURE_BLOB_ACCOUNT`           | yes           | Storage account name.                                                                                          |
| `AZURE_BLOB_KEY`               | one auth mode | Base64 account key. Preferred when set; otherwise use all three Entra client-credential variables below.       |
| `AZURE_BLOB_CONTAINER`         | yes           | Container that new uploads go to.                                                                              |
| `AZURE_BLOB_ENDPOINT`          | yes           | Account URL as the **browser** sees it, e.g. `https://<account>.blob.core.windows.net`.                        |
| `AZURE_BLOB_INTERNAL_ENDPOINT` | no            | Account URL **Convex** uses for its own requests, when it differs (self-hosted Convex in Docker, for example). |
| `AZURE_BLOB_PUBLIC_BASE_URL`   | no            | Serve reads as `<base>/<blob name>` without a token: a CDN, or a container with public read access.            |
| `AZURE_BLOB_TENANT_ID`         | Entra mode    | Microsoft Entra tenant ID.                                                                                     |
| `AZURE_BLOB_CLIENT_ID`         | Entra mode    | Microsoft Entra application client ID.                                                                         |
| `AZURE_BLOB_CLIENT_SECRET`     | Entra mode    | Microsoft Entra application client secret.                                                                     |
| `AZURE_BLOB_AUTHORITY_HOST`    | no            | Microsoft Entra authority base URL; defaults to `https://login.microsoftonline.com`.                           |

You can pass the same values as `config` to the constructor instead.

### Microsoft Entra user-delegation SAS

Use these steps to configure a test storage account and Microsoft Entra
application for user-delegation SAS. Use a dedicated test account/container, not
production.

#### 1. Register a single-tenant app

In the [Microsoft Entra admin center](https://entra.microsoft.com), go to
**Entra ID → App registrations → New registration**:

1. Enter a name, for example `convex-azure-blob-test`.
2. Leave **Supported account types** set to **Accounts in this organizational
   directory only (Single tenant)**.
3. Leave **Redirect URI** blank; this server-to-server client-credentials flow
   does not use a redirect.
4. Select **Register**.

From the app's **Overview** page, save the **Directory (tenant) ID** and
**Application (client) ID**. These are configuration values, not secrets.

#### 2. Create a client secret

Open **Certificates & secrets → Client secrets → New client secret**. Add a
description and choose an expiry, then select **Add**. Copy the secret's
**Value** immediately; it is only shown once. Store it securely and never commit
it, put it in a screenshot, or paste it into chat.

#### 3. Prepare the storage account

Use a general-purpose v2 storage account and create a private blob container for
testing, such as `convex-test`. On the storage account's **Security** settings:

- Leave **Require secure transfer for REST API operations** enabled.
- Leave anonymous container access disabled.
- Clear **Enable storage account key access**. This is the setting that ensures
  the test exercises Entra authorization rather than account-key auth.
- Keeping the minimum TLS version at 1.2 is recommended.

The portal's **Default to Microsoft Entra authorization** option only changes
the portal's default sign-in behavior; it does not grant the app access. Azure
RBAC role assignments below grant that access.

For uploads from the example's browser, also configure the storage account's
**Resource sharing (CORS) → Blob service** rule for `http://localhost:5173`,
including allowed upload headers, then **Save**. Follow the exact
[local CORS values above](#an-azure-storage-account). This browser requirement
is separate from Entra app roles and is easy to miss when server-side tests
pass.

#### 4. Assign the app's Azure roles

For **Storage Blob Delegator**, open the storage account's **Access control
(IAM) → Add → Add role assignment** and choose the **Storage Blob Delegator**
role. Assign it at the **storage account** scope; this role allows the app to
request user-delegation keys.

For **Storage Blob Data Contributor**, open the test container's **Access
control (IAM) → Add → Add role assignment** and choose that role. This grants
blob read, write, and delete access to the test container only. If container
scope is unavailable, assign it from the storage account's IAM page instead,
which grants access to all containers in that account.

For both assignments, select **User, group, or service principal** under
**Assign access to** (not **Managed identity**), then select the app
registration you created. In the member picker it may appear as an
**Application**; confirm the app appears in the Members table before continuing.
Do not proceed if the review page says **No members selected**. Select
**Review + assign**, verify the role, scope, and app member, then select
**Review + assign** again to submit. Allow a few minutes for role assignments to
propagate before testing.

#### 5. Configure the Convex development deployment

From your project directory, set the account name, endpoint, container, tenant
ID, and client ID on the **development** deployment:

```sh
npx convex env set AZURE_BLOB_ACCOUNT '<storage-account-name>'
npx convex env set AZURE_BLOB_ENDPOINT 'https://<storage-account-name>.blob.core.windows.net'
npx convex env set AZURE_BLOB_CONTAINER '<test-container-name>'
npx convex env set AZURE_BLOB_TENANT_ID '<directory-tenant-id>'
npx convex env set AZURE_BLOB_CLIENT_ID '<application-client-id>'
```

Set the client secret interactively so it is not included in the command or
shell history:

```sh
npx convex env set AZURE_BLOB_CLIENT_SECRET
```

Do not set `AZURE_BLOB_KEY` for this test. If it is already set on this
development deployment, remove it:

```sh
npx convex env remove AZURE_BLOB_KEY
```

You can optionally set `AZURE_BLOB_AUTHORITY_HOST` for a sovereign cloud; the
default is `https://login.microsoftonline.com`. If `AZURE_BLOB_KEY` is set,
account-key auth takes precedence and Entra credentials are not used.

The two role scopes above are intentionally different: **Storage Blob
Delegator** must be assigned at the storage account, resource group, or
subscription scope; **Storage Blob Data Contributor** can be scoped to the
container. See Microsoft's docs for
[user-delegation SAS permissions](https://learn.microsoft.com/azure/storage/blobs/storage-blob-user-delegation-sas-create)
and
[Get User Delegation Key](https://learn.microsoft.com/rest/api/storageservices/get-user-delegation-key).

The example's `refreshUserDelegationKey` internal action is scheduled daily and
refreshes the key when it has less than two days remaining. Run the action once
from the Convex dashboard after deployment to initialize the cache; uploads and
signed read URLs fail with a clear error until a valid key is cached. Keys are
valid for at most seven days.

The cached delegation key is a signing secret stored in the component table.
Treat access to the Convex deployment and its component data as privileged.
Azure's **Revoke User Delegation Keys** operation invalidates the cached key and
all SAS URLs signed with delegation keys; the cron must obtain a new key before
Entra-backed SAS operations can continue. The routine refresh keeps a cached key
that is still valid, so after revoking, force a replacement. Check the
revocation first, then run the example action with `force`:

```sh
npx convex run photos:refreshUserDelegationKey '{"force":true}'
```

`refreshUserDelegationKey(ctx, { force: true })` skips the cached key and stores
the replacement. If the forced request fails, the cached key is kept and the
error is thrown. Uploads that were in flight need a fresh upload URL.

Pre-release deployments may contain file records created before
`uploadExpiresAt` was stored. These records remain valid and are not rewritten;
cleanup uses the file's creation time plus the configured upload TTL, with a
one-hour minimum, as a conservative expiry fallback.

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

### Large files and resumable uploads

Single-PUT uploads remain the default. Opt into block uploads for large files:

```ts
export const azure = new AzureBlob(components.azureBlob, {
  blockUploads: true,
  maxBytes: 1024 * 1024 * 1024, // choose an application-specific ceiling
});

export const { generateUploadUrl, renewUploadUrl, confirmUpload } =
  azure.clientApi({
    identify: async (ctx) =>
      (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null,
  });
```

Block uploads require the file's `size`. Their ticket retains `fileId`,
`uploadUrl`, and `headers`, and adds `kind: "blocks"`, `blockSize`, and
`expiresAt`. The React hook detects the ticket automatically:

```tsx
const {
  upload,
  pause,
  resume,
  cancel,
  canResume,
  progress,
  isUploading,
  error,
} = useUploadFile(api.files);
```

- `upload(file)` starts a new session. Each chunk is a `Blob.slice()` sent
  directly to Azure, with bounded parallel requests and aggregate byte progress.
- `pause()` aborts active requests but keeps the file and successful block IDs.
  `resume()` renews the same upload ticket and sends only unfinished blocks.
  Handle the rejected upload promise as well as displaying `error`.
- A failed transfer can be resumed when `canResume` is true. `cancel()` discards
  the session; it does not immediately delete Azure's staged blocks.
- Resume state exists only in this hook instance. Reloading, leaving the page,
  or unmounting the uploader discards it. No SAS tokens or file data are saved
  to browser storage.
- Use separate hook instances for separate files, or await uploads sequentially.
  Starting another upload on the same hook cancels its previous session.

Only the uploader may renew or confirm a session. Convex checks the staged block
count, ordering, and sizes before committing the block list, then checks the
committed type and signature. Confirmed reads use an immutable snapshot so the
staging SAS cannot change the bytes that have been verified. With the pinned
Azure API version, staging needs a short-lived, single-blob **write** SAS;
unlike the default create-only ticket, it is not a permission boundary against a
malicious client committing or changing the staging blob. Only verified content
is published by Convex.

Azure has finite limits: at most 50,000 blocks and 4,000 MiB per block for the
service version used here (about 190.7 TiB per blob). Your configured `maxBytes`
still applies; the SDK's default remains 10 MiB. Unfinished Azure blocks expire
after seven days, and the sweep removes abandoned Convex reservations after
their upload expiry. Keep the sweep running.

For custom public upload functions, authorize the uploader before calling the
SDK and expose a compatible `renewUploadUrl({ fileId })` mutation for the hook.
`store` remains a single-PUT server-side upload; block mode is for browser
upload sessions.

### Event Grid upload confirmation

The browser normally calls `confirmUpload` after Azure accepts a PUT. To recover
when the browser closes or loses its connection first, mount an Event Grid
handler in `convex/http.ts`:

```ts
const handler = azure.eventGridHandler({
  secret: process.env.AZURE_BLOB_EVENT_GRID_SECRET ?? "",
  onUpload: internal.photos.attach,
});

http.route({
  path: "/azure-blob/events",
  method: "POST",
  handler,
});
```

Set `AZURE_BLOB_EVENT_GRID_SECRET` in Convex before deploying the route. The
secret must be at least 32 characters; generate a random value rather than
choosing a password. This callback should match the `onUpload` used by
`clientApi`, so the browser and Event Grid confirm the same app record.

Generate and set a secret, then create a standard-schema Event Grid subscription
for the storage account:

```sh
secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
npx convex env set AZURE_BLOB_EVENT_GRID_SECRET "$secret"
resource_group="<resource-group>"
account="<storage-account>"
deployment="<deployment>"
account_id="$(az storage account show --name "$account" --resource-group "$resource_group" --query id -o tsv)"
az eventgrid event-subscription create \
  --name confirm-blob-uploads \
  --source-resource-id "$account_id" \
  --endpoint-type webhook \
  --endpoint "https://$deployment.convex.site/azure-blob/events?secret=$secret" \
  --included-event-types Microsoft.Storage.BlobCreated \
  --event-delivery-schema EventGridSchema
```

The handler answers Event Grid's subscription-validation handshake, confirms
tracked blobs through the same size, type, and signature checks as the browser,
and runs the configured `onUpload` mutation atomically. Duplicate events and
browser/event races are safe; unknown blobs, containers, and event types are
acknowledged without changes. Transient confirmation failures return HTTP 503 so
Event Grid retries them. Keep the endpoint on HTTPS. Query-string secrets can
appear in URLs, deployment settings, or access logs; restrict access to those
records, avoid logging the full request URL, and rotate the Convex secret and
Event Grid subscription endpoint together.

### Defender for Storage malware scan gate

For single-PUT uploads, opt in to keeping confirmed files private until Defender
for Storage reports a clean scan:

```ts
export const azure = new AzureBlob(components.azureBlob, {
  requireMalwareScan: true,
});
const uploadApi: ReturnType<AzureBlob["clientApi"]> = azure.clientApi({
  identify: async (ctx) =>
    (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null,
});
export const { generateUploadUrl, confirmUpload, scanMalware } = uploadApi;
```

`scanMalware` is an internal action. Schedule it from a Convex cron so pending
scan jobs are polled:

```ts
crons.interval(
  "check malware scan results",
  { minutes: 1 },
  internal.files.scanMalware,
  {},
);
```

Enable Defender for Storage **on-upload malware scanning** for the storage
account and leave scan-result blob index tags enabled. Blob index tags aren't
supported on accounts with hierarchical namespace enabled. The scanner reads the
`Malware scanning scan result` tag (also accepts `Scan result`) using
`Get Blob Tags`. `No threats found` is clean; `Malicious` deletes the blob and
retains a `rejected` file row. Other outcomes, including `Not scanned` and
errors, remain unservable and eventually time out. For account-key SAS this
requires the `t` permission; in Entra mode, the identity needs the
`Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read` data
action. Files stay in `scanning` until a clean verdict or become
`scan_timed_out` after 24 hours without a definitive result. `getUrl` only
serves `ready` files, and `onUpload` runs only after a clean scan. Apps can read
`getFile` to display the scanning, rejected, or timed-out state. Rejected-blob
cleanup continues through the upload ticket's expiry and a clock-skew grace
period, so a still-valid create-only SAS cannot recreate it.

Scanning is asynchronous: actual latency varies with file size, type and service
load. Defender for Storage bills per GB scanned; configure its monthly scanning
cap to control cost. If the cap is reached or tags are unavailable, the file
remains unservable and eventually times out. The package polls in bounded
batches with backoff; the cron interval controls how quickly new results are
observed.

Blob index tags are not tamper-resistant. Principals allowed to modify tags can
alter the verdict, so do not treat tag polling as the sole security control for
high-assurance workflows; use Defender's Event Grid events or alerts as
appropriate. The option cannot be combined with `blockUploads`: the block upload
SAS can change the mutable base blob after confirmation, while the library
serves an immutable snapshot, and Defender's tag does not prove that snapshot
was scanned.

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
`azure.urlForFile(file, options, ctx)` to skip a second lookup. The query
context is required for Entra authentication so the cached delegation key can be
read without a network request; it is optional with account-key authentication.

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
crons.interval(
  "refresh Azure Blob user delegation key",
  { hours: 24 },
  internal.files.refreshUserDelegationKey,
  {},
);
export default crons;

// convex/files.ts
export const sweep = internalAction({
  args: {},
  handler: async (ctx) => await azure.sweep(ctx),
});

export const refreshUserDelegationKey = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await azure.refreshUserDelegationKey(ctx);
    return null;
  },
});
```

`azure.delete` is an alias of `purge`. After a delete, the row stays in the
`deleting` state until the file's recorded `uploadExpiresAt` plus a five-minute
clock-skew allowance, because that URL could otherwise re-create the blob. A
later sweep removes it. Changing client TTL settings does not shorten this
retention. Sweep atomically claims stale pending uploads before deleting them,
so a confirmation that commits first is not swept. Each sweep examines at most
1000 expired pending rows in expiry order while skipping those younger than the
age cutoff; if more than 1000 young rows sort ahead of an older one, it waits
until they age out.

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

When a source is already available at an HTTPS URL, Azure can fetch it directly
without passing the bytes through the Convex action:

```ts
const result = await azure.storeFromUrl(ctx, {
  sourceUrl,
  contentType: "image/png",
  uploadedBy: userId,
  fileName: "avatar",
  maxBytes: 5 * 1024 * 1024,
});
if (!result.ok) throw new Error(result.reason);
return result.fileId;
```

`storeFromUrl` accepts only HTTPS source URLs and applies the same size,
content-type and file-signature checks as `store`. The source must be publicly
readable or include a read SAS, and must return a valid `Content-Length`. Source
URLs are limited to 2 KiB. Azure's synchronous operation is limited to 5,000
MiB; an oversized source or one without a valid length is rejected. Azure
fetches the source URL itself, so treat user-supplied URLs as an SSRF risk:
validate them against your application's trusted-source policy before calling
this method. HTTPS alone does not make an arbitrary URL safe. Do not log source
URLs that contain SAS tokens.

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
- **Malware scanning is opt-in.** Use `requireMalwareScan` with Defender for
  Storage to keep confirmed files unservable until a clean scan result arrives.
  Without it, files are not checked for malware. See
  [Defender for Storage](https://learn.microsoft.com/azure/defender-for-cloud/defender-for-storage-introduction)
  and the scan-gate section above. SVG is not in the default allow-list, because
  it can carry script.
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

## Local development with Azurite

[Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)
emulates Blob Storage and validates SAS signatures the way Azure does. It does
not implement the Get User Delegation Key REST API or Entra OAuth, so
user-delegation authentication is covered by mocked tests and must be verified
against an Azure storage account.

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

| Option                | Default                         | Meaning                                                                                                                                   |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `config`              | env vars                        | `{ accountName, accountKey?, tenantId?, clientId?, clientSecret?, authorityHost?, container, endpoint, internalEndpoint, publicBaseUrl }` |
| `allowedContentTypes` | JPEG/PNG/WebP/GIF/AVIF          | Content type → blob-name extension.                                                                                                       |
| `maxBytes`            | 10 MiB                          | Size ceiling. Callers can ask for less, never more.                                                                                       |
| `blockUploads`        | `false`                         | Opt into resumable browser block uploads; requires `size` and a renewal mutation.                                                         |
| `requireMalwareScan`  | `false`                         | Poll Defender scan tags before serving; requires the `clientApi` scan action cron and cannot be combined with `blockUploads`.             |
| `pathPrefix`          | none                            | Virtual folder for new blobs, e.g. `"users/avatars"`.                                                                                     |
| `uploadTtlSeconds`    | 300                             | Lifetime of upload URLs.                                                                                                                  |
| `readWindowSeconds`   | 3600                            | Signing window for read URLs. Each URL is valid for one to two windows.                                                                   |
| `verifyContent`       | `true`                          | Check leading bytes against the file signature at confirm.                                                                                |
| `httpsOnly`           | `true` for `https://` endpoints | Sign tokens with `spr=https`.                                                                                                             |

### Methods

The `ctx` type each method needs is the smallest that works, so you can call
query methods from mutations and actions too.

| Method                                                                                        | Call from    | Returns                                                                         |
| --------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `generateUploadUrl(ctx, { contentType, uploadedBy, maxBytes?, size?, fileName?, metadata? })` | mutation     | `{ fileId, uploadUrl, headers }`                                                |
| `renewUploadUrl(ctx, { fileId, uploadedBy })`                                                 | mutation     | Same pending upload ticket with a renewed expiry; authorize the uploader first. |
| `confirmUpload(ctx, fileId, onUpload?)`                                                       | action       | `{ ok: true, size, contentType }` or `{ ok: false, reason }`                    |
| `getFile(ctx, fileId)`                                                                        | query        | `FileDoc` or `null`                                                             |
| `getUrl(ctx, fileId, { download?, cacheControl? })`                                           | query        | URL or `null`                                                                   |
| `urlForFile(file, { download?, cacheControl? }, ctx?)`                                        | anywhere     | URL or `null`                                                                   |
| `list(ctx, { uploadedBy?, paginationOpts })`                                                  | query        | `PaginationResult<FileDoc>`                                                     |
| `updateFile(ctx, fileId, { fileName?, metadata? })`                                           | mutation     | `boolean`                                                                       |
| `markForDeletion(ctx, fileId)`                                                                | mutation     | `boolean`                                                                       |
| `purge(ctx, fileId)` / `delete(ctx, fileId)`                                                  | action       | `boolean`                                                                       |
| `sweep(ctx, { pendingOlderThanMs?, limit? })`                                                 | action       | number of blobs removed                                                         |
| `store(ctx, { data, contentType, uploadedBy, maxBytes?, fileName?, metadata? })`              | action       | `{ ok: true, fileId }` or `{ ok: false, reason }`                               |
| `storeFromUrl(ctx, { sourceUrl, contentType, uploadedBy, maxBytes?, fileName?, metadata? })`  | action       | `{ ok: true, fileId }` or `{ ok: false, reason }`                               |
| `refreshUserDelegationKey(ctx, { force? })`                                                   | action       | `void`; refreshes the Entra delegation-key cache; `force` replaces a valid key  |
| `scanMalware(ctx, limit?)`                                                                    | action       | number of due Defender scan jobs checked                                        |
| `clientApi({ identify, checkUpload?, onUpload? })`                                            | module scope | public upload functions and internal `scanMalware` action                       |
| `eventGridHandler({ secret, onUpload? })`                                                     | module scope | HTTP action for standard-schema Event Grid BlobCreated events                   |

### `convex-azure-blob/react`

- `useUploadFile(api)` returns
  `{ upload, cancel, pause, resume, canResume, progress, isUploading, error }`.
  `api` has `generateUploadUrl` and `confirmUpload` function references, plus
  `renewUploadUrl` for resumable block uploads.
- `uploadToAzure(uploadUrl, file, { headers?, onProgress?, signal? })` is the
  same upload without React.
- `uploadBlocksToAzure(ticket, file, { headers?, onProgress?, signal?, stagedBlockIds? })`
  stages blocks without committing them. Retain the successful `Set<string>` of
  `stagedBlockIds` for retries, renew expired tickets, then call your
  owner-authorized `confirmUpload`.
- `UploadError` is thrown for failed PUTs (with `status`) and rejected
  confirmations.
- Starting another upload cancels the previous one. Cancellation also applies
  while waiting for an upload ticket, and unmounting aborts the active PUT. A
  confirmation already sent to the server cannot be undone by cancellation.
  `pause()` differs from `cancel()` by keeping the in-memory block session for
  `resume()`; single-PUT uploads cannot resume staged blocks.

`FileDoc` has optional `uploadMode`, `expectedSize`, `blockSize`, and `snapshot`
fields for block sessions. These fields are absent on legacy and single-PUT
records. Snapshot-backed reads use signed Azure snapshot URLs even when
`publicBaseUrl` is configured, to avoid serving the mutable base blob.

### Lower-level exports

`signBlobSas`, `blobStringToSign`, `attachmentDisposition`, `sniffContentType`,
`SNIFFABLE_CONTENT_TYPES`, `resolveConfig` and `SAS_VERSION`, for advanced use
and your own tests.

<!-- END: Include on https://convex.dev/components -->

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

For live Azure with Entra authentication, use the
[Entra setup guide](#microsoft-entra-user-delegation-sas). The storage account's
**Blob service CORS** rule must include the exact frontend origin, such as
`http://localhost:5173` (and a different origin if Vite chooses a different
port). Allow `PUT, GET, HEAD, OPTIONS`, the headers in the
[CORS prerequisites](#an-azure-storage-account), and expose `etag`. A successful
server-side integration test does not prove browser CORS is configured. The UI
reports network/CORS failures per file instead of silently dropping a batch;
after fixing the rule, resume the failed transfer.

## Roadmap

Azure features in priority order. The first two are implemented in Unreleased;
the remaining entries are future work. Contributions welcome:

1. **User delegation SAS — implemented** (Microsoft Entra ID instead of the
   account key), for accounts with shared-key access disabled.
2. **Large files with block uploads — implemented** (`Put Block` /
   `Put Block List`) and resumable uploads, with the size checked before Convex
   commits the blob.
3. **Malware scan gate**: serve a file only after Defender for Storage reports
   it clean.
4. **Stored access policies**, to revoke outstanding URLs without rotating the
   key.
5. **Event Grid** `BlobCreated` webhooks to confirm uploads without a client
   round trip.
6. **Copy from URL** (`Put Blob From URL`) for imports that skip Convex.
7. **Faster sweeps**: parallel deletes, draining large backlogs, and backoff for
   blobs that fail to delete.
8. **Reading files from actions**, including range reads.
9. **Checksums** (`Content-MD5`) verified at upload and confirm.
10. **Access tiers** (Hot, Cool, Cold, Archive) per file, and lifecycle hints.
11. **Blob index tags** for lifecycle rules and search across files.
12. **Encryption scopes** per container or tenant.
13. **Setup check** that diagnoses the key, container and CORS rule.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE)
