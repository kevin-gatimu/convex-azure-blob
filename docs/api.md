# API reference

The `AzureBlob` class, its methods, and the other exports.
[Back to the README](../README.md)

## `new AzureBlob(component, options?)`

| Option                | Default                         | Meaning                                                                                                                                   |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `config`              | env vars                        | `{ accountName, accountKey?, tenantId?, clientId?, clientSecret?, authorityHost?, container, endpoint, internalEndpoint, publicBaseUrl }` |
| `allowedContentTypes` | JPEG/PNG/WebP/GIF/AVIF          | Content type → blob-name extension.                                                                                                       |
| `maxBytes`            | 10 MiB                          | Size ceiling. Callers can ask for less, never more.                                                                                       |
| `blockUploads`        | `false`                         | Opt into resumable browser block uploads; requires `size` and a renewal mutation.                                                         |
| `requireMalwareScan`  | `false`                         | Poll Defender scan tags before serving; requires the `clientApi` scan action cron and cannot be combined with `blockUploads`.             |
| `accessTier`          | none                            | Server-side ready-file tier: Hot, Cool, Cold, or Archive.                                                                                 |
| `pathPrefix`          | none                            | Virtual folder for new blobs, e.g. `"users/avatars"`.                                                                                     |
| `encryptionScope`     | none                            | Existing Azure encryption scope for new blobs; see [Encryption scopes](./encryption-scopes.md).                                           |
| `uploadTtlSeconds`    | 300                             | Lifetime of upload URLs, from 1 to 604800 (seven days).                                                                                   |
| `readWindowSeconds`   | 3600                            | Signing window for read URLs, from 1 to 604800. Each URL is valid for one to two windows.                                                 |
| `verifyContent`       | `true`                          | Check leading bytes against the file signature at confirm.                                                                                |
| `httpsOnly`           | `true` for `https://` endpoints | Sign tokens with `spr=https`.                                                                                                             |

## Methods

The `ctx` type each method needs is the smallest that works, so you can call
query methods from mutations and actions too.

| Method                                                                                               | Call from    | Returns                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `generateUploadUrl(ctx, { contentType, uploadedBy, maxBytes?, size?, fileName?, metadata?, tags? })` | mutation     | `{ fileId, uploadUrl, headers }`                                                                         |
| `renewUploadUrl(ctx, { fileId, uploadedBy })`                                                        | mutation     | Same pending upload ticket with a renewed expiry; authorize the uploader first.                          |
| `confirmUpload(ctx, fileId, onUpload?)`                                                              | action       | `{ ok: true, size, contentType }` or `{ ok: false, reason }`                                             |
| `getFile(ctx, fileId)`                                                                               | query        | `FileDoc` or `null`                                                                                      |
| `read(ctx, fileId, { range?: { start, end? } }?)`                                                    | action       | `Response` (200, or 206 with `range`), or `null` unless the file is `ready`                              |
| `getUrl(ctx, fileId, { download?, cacheControl? })`                                                  | query        | URL or `null`                                                                                            |
| `urlForFile(file, { download?, cacheControl? }, ctx?)`                                               | anywhere     | URL or `null`                                                                                            |
| `list(ctx, { uploadedBy?, paginationOpts })`                                                         | query        | `PaginationResult<FileDoc>`                                                                              |
| `updateFile(ctx, fileId, { fileName?, metadata? })`                                                  | mutation     | `boolean`                                                                                                |
| `getTags(ctx, fileId)`                                                                               | action       | `Record<string, string>` or `null`                                                                       |
| `setTags(ctx, fileId, tags)`                                                                         | action       | `boolean`                                                                                                |
| `setTier(ctx, fileId, tier)`                                                                         | action       | `boolean`                                                                                                |
| `rehydrate(ctx, fileId, { tier, priority? })`                                                        | action       | `boolean`                                                                                                |
| `refreshTier(ctx, fileId)`                                                                           | action       | `boolean`                                                                                                |
| `markForDeletion(ctx, fileId)`                                                                       | mutation     | `boolean`                                                                                                |
| `purge(ctx, fileId)` / `delete(ctx, fileId)`                                                         | action       | `boolean`                                                                                                |
| `sweep(ctx, { pendingOlderThanMs?, limit?, concurrency?, continueWith?, run?, maxRuns? })`           | action       | number of blobs removed                                                                                  |
| `store(ctx, { data, contentType, uploadedBy, maxBytes?, fileName?, metadata?, tags? })`              | action       | `{ ok: true, fileId }` or `{ ok: false, reason }`                                                        |
| `storeFromUrl(ctx, { sourceUrl, contentType, uploadedBy, maxBytes?, fileName?, metadata?, tags? })`  | action       | `{ ok: true, fileId }` or `{ ok: false, reason }`                                                        |
| `refreshUserDelegationKey(ctx, { force? })`                                                          | action       | `void`; refreshes the Entra delegation-key cache; `force` replaces a valid key                           |
| `checkSetup(ctx, { origin?, checksum? }?)`                                                           | action       | `{ ok, checks: [{ name, ok, hint? }] }`; see [Checking your setup](./azure-setup.md#checking-your-setup) |
| `scanMalware(ctx, limit?)`                                                                           | action       | number of due Defender scan jobs checked                                                                 |
| `clientApi({ identify, checkUpload?, onUpload? })`                                                   | module scope | public upload functions and internal `scanMalware` action                                                |
| `eventGridHandler({ secret, onUpload? })`                                                            | module scope | HTTP action for standard-schema Event Grid BlobCreated events                                            |

## `convex-azure-blob-storage/react`

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

## Lower-level exports

`signBlobSas`, `blobStringToSign`, `attachmentDisposition`, `sniffContentType`,
`SNIFFABLE_CONTENT_TYPES`, `resolveConfig` and `SAS_VERSION`, for advanced use
and your own tests.

<!-- END: Include on https://convex.dev/components -->
