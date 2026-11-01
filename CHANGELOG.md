# Changelog

## Unreleased

- Add server-side access tier defaults, `setTier`, `rehydrate`, and
  `refreshTier`, plus exported access-tier/archive-status validators and
  optional file properties. Archived files stay unservable through rehydration;
  failed automatic tiering preserves ready files and reads their actual tier.
  The README covers pricing, lifecycle policies, polling, and archived snapshot
  restrictions.
- Add bounded sweep concurrency (default 8) and optional internal-action drain
  scheduling with `continueWith`, `run`, and `maxRuns` (default 10). Failed blob
  deletes use exponential backoff capped at 24 hours; live upload URLs defer
  cleanup until expiry plus clock skew. File records gain optional
  `nextAttemptAt` and `sweepAttempts`; the component adds `deferSweep` and an
  indexed due-time selection. The README documents the options and cron wrapper.
- Add `AzureBlob.read(ctx, fileId, { range? })` to read a ready file's bytes
  from an action, optionally an inclusive byte range (206). It returns null for
  an unknown or not-ready file, and throws without exposing the URL or SAS when
  Azure answers with an error.
- Add `storeFromUrl` to copy HTTPS sources directly into Azure Blob Storage,
  then apply the normal size, content-type and signature checks. Azure's
  synchronous copy is limited to 5,000 MiB; the README documents source URL
  validation and the source's `Content-Length` requirement.
- Add `eventGridHandler({ secret, onUpload? })` for standard-schema Azure Event
  Grid `BlobCreated` events. It handles subscription validation, confirms
  tracked uploads through the normal checks, and makes repeated delivery safe.
  Transient confirmation failures return a retryable status. The README covers
  the HTTPS route, shared-secret setup, Azure CLI subscription, and rotation.
- Add opt-in Defender for Storage malware scanning with internal polling,
  `scanning`/`rejected`/`scan_timed_out` statuses, and a 24-hour timeout.
  `onUpload` runs only after a clean verdict; block uploads cannot enable this
  gate because their mutable blob tags cannot verify the immutable snapshot.
  Blob index tags must be enabled, and hierarchical-namespace accounts are not
  supported. Rejected-blob cleanup persists through upload SAS expiry, and
  scanner failures are retried independently without blocking the batch.
- Add opt-in resumable browser block uploads via `blockUploads`, block ticket
  metadata, owner-authorized `renewUploadUrl`, and React `pause`, `resume`, and
  `canResume`. The default single-PUT flow and server-side `store` remain
  unchanged. Confirmed block files use immutable snapshot reads.
- Expand the React example to single and multi-file queues, image/document/
  archive/audio/video uploads, progress, pause/resume, explicit connection and
  deletion errors, and a clear explanation of the direct Azure/Convex flow. Keep
  signature validation and document finite Azure limits and the shared demo
  identity.
- Fix development script quoting for Windows.
- Add a View file action to the example that opens the verified read URL in a
  new tab, separate from the attachment download.
- Add Microsoft Entra client-credential authentication and user-delegation SAS
  for accounts with shared-key access disabled. The account-key path remains
  preferred when `AZURE_BLOB_KEY` is configured.
- Add `refreshUserDelegationKey` for caching delegation keys, and allow
  `urlForFile` to receive a query context so it can sign URLs without network
  calls. See the README for role assignments, configuration, and key-revocation
  guidance.
- `AzureBlobConfig.authorityHost` is optional again, so existing config objects
  still compile; Entra token requests default to
  `https://login.microsoftonline.com`.
- `refreshUserDelegationKey` accepts `{ force: true }` to replace a still-valid
  cached key after revocation; the example action forwards `force`.
- Renewing an upload never shortens the cleanup expiry tracked for an earlier
  issued URL, and the sweep no longer lets young short-lived uploads starve
  eligible older ones.
- The example shows Retry for every failed upload, even when a resume cannot
  continue.
- Keep pre-release file records without `uploadExpiresAt` compatible with schema
  updates; cleanup applies a conservative expiry fallback without rewriting or
  deleting those records.

## 0.1.0

First public release.

- Confirmation and its optional `onUpload` attachment commit atomically.
  `onUpload` is an internal mutation reference accepting `{ fileId }`, not an
  action callback. Failed attachments roll back confirmation and can be retried;
  repeated confirmations do not duplicate committed attachments.
- Sweep claims stale uploads transactionally, preventing deletion of a file that
  confirmed first. Confirmation refuses files already claimed for deletion.
- Each file records its issued `uploadExpiresAt`, so cleanup retains tracking
  until that expiry plus clock-skew allowance even if client TTL settings
  change. Legacy rows without this field use the configured upload TTL (with a
  one-hour minimum) as a cleanup fallback.
- Upload hooks isolate overlapping uploads, honor cancellation while waiting for
  tickets, and abort active transfers on unmount.
- Publishing enforces clean build, tests, lint, types and a packed-consumer
  check against the minimum supported Convex and React versions.
- The minimum Convex version is 1.46, matching the `convex-helpers` dependency.
  Packed-consumer installation rejects peer dependency conflicts.
- Direct browser uploads to Azure Blob Storage with create-only, single-blob,
  short-lived SAS URLs. SAS signing uses Web Crypto, with no Azure SDK.
- `confirmUpload` checks the stored blob's size, content type and file signature
  (magic bytes) before a file is served.
- Read URLs signed per time window, with optional download file names
  (`Content-Disposition`) and `Cache-Control` overrides, or a public or CDN base
  URL.
- File names, string metadata, and paginated listing per uploader.
- Transactional `markForDeletion`, `purge`, and a `sweep` for abandoned uploads
  and failed deletes.
- Server-side `store` for imports and migrations.
- Several containers and `pathPrefix` folders through one component.
- HTTPS-only tokens for `https://` endpoints.
- `clientApi()` for ready-made upload functions, and the `useUploadFile` React
  hook with progress and cancel.
- `convex-azure-blob/test` helper for convex-test.
