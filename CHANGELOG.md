# Changelog

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
  change. Pre-release deployments with existing rows must populate this required
  field with the actual issued expiry, or recreate their development component
  data, before deploying the new schema.
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
