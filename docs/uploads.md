# Uploads in depth

Large files, integrity checks, custom upload functions, and the allowed types
and sizes. [Back to the README](../README.md)

## Large files and resumable uploads

Single-PUT uploads remain the default. Opt into block uploads for large files:

```ts
export const azure = new AzureBlob(components.azureBlobStorage, {
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
- While paused, `progress` counts only the blocks Azure has stored, since
  in-flight bytes are sent again, and `resume()` continues from that value.
- A failed transfer can be resumed when `canResume` is true. A file that
  `confirmUpload` rejects (wrong type, size or checksum) is deleted, so
  `canResume` turns false and only a new `upload()` can retry it; an expired
  ticket stays resumable. `cancel()` discards the session; it does not
  immediately delete Azure's staged blocks.
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

The staging write SAS lets a client stage uncommitted blocks, up to Azure's
limits, until the ticket expires. Uncommitted blocks are billed until Azure
discards them after seven days, and `maxBytes` is only enforced at confirm. Keep
`uploadTtlSeconds` short, rate-limit with `checkUpload`, and set a cost or
lifecycle alert on the storage account.

For custom public upload functions, authorize the uploader before calling the
SDK and expose a compatible `renewUploadUrl({ fileId })` mutation for the hook.
`store` remains a single-PUT server-side upload; block mode is for browser
upload sessions.

## Integrity check with MD5

Pass an optional `md5` to `generateUploadUrl`: the file's MD5 digest as base64
(exactly 16 bytes). The ticket's `headers` then include `Content-MD5`, so Azure
refuses a PUT whose body differs, and `confirmUpload` rejects (and deletes) a
blob whose stored `Content-MD5` is missing or different, with the reason
`Checksum mismatch`. An invalid `md5` throws a `ConvexError`.

The app must compute the digest itself: Web Crypto has no MD5 and this package
adds no hashing dependency. Use any MD5 implementation you trust, then:

```ts
const { upload } = useUploadFile(api.files);
const fileId = await upload(file, { md5 }); // md5: base64 of the 16-byte digest
```

`useUploadFile` forwards extra arguments to your `generateUploadUrl` (add
`md5: v.optional(v.string())` to a custom mutation's args; `clientApi` already
accepts it) and sends the ticket headers with the PUT. Add `content-md5` to the
CORS rule's **Allowed headers** so browsers may send it. `md5` is not supported
with `blockUploads`: passing both throws a `ConvexError`.

## Writing your own upload functions

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
from `convex-azure-blob-storage/react`, or any HTTP client: `PUT` the bytes to
`uploadUrl` with the returned `headers`.

## Allowed types and sizes

By default the allow-list is JPEG, PNG, WebP, GIF and AVIF. Change it with
`allowedContentTypes`, which maps each content type to the extension of the
generated blob name:

```ts
new AzureBlob(components.azureBlobStorage, {
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

Warning: browsers can execute some content types (`text/html`, `image/svg+xml`,
`application/xhtml+xml`, `text/javascript`, XML). They are served with that type
from the storage origin, and Azure does not send
`X-Content-Type-Options: nosniff`. If you must accept them, serve them as
downloads (`getUrl(ctx, id, { download: true })`) or from a separate storage
account or domain with no cookies.
