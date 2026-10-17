# Changelog

## 0.1.0

First public release.

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
