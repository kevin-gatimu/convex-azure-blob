# Changelog

## Unreleased

- Add server-chosen blob index tags to uploads, `store`, and `storeFromUrl`,
  with ready-time Defender-preserving merges and the `getTags`/`setTags`
  actions.
- Add the `encryptionScope` option. Upload tickets, block staging and commit,
  `store`, and `storeFromUrl` write new blobs into that Azure encryption scope
  (SAS `ses`, or `x-ms-encryption-scope` with Entra bearer auth). Reads, tags,
  tiers, and deletes are unchanged. Invalid names are rejected at construction.
- Docs: the README now covers setup and the basic flow; feature guides moved to
  `docs/`.

## 0.1.1

Documentation only; no code changes.

- README: a new "Required crons" section lists the `sweep`,
  `refreshUserDelegationKey` and `scanMalware` jobs, when each is needed, and
  what breaks without them.
- README: the "Deleting files" cron example now refreshes the user delegation
  key hourly instead of every 24 hours, which left minutes each day with no
  valid key.
- README: a Convex Components directory badge.

## 0.1.0

First public release, as `convex-azure-blob-storage`.

### Uploads

- Direct browser uploads to Azure Blob Storage with create-only, single-blob,
  short-lived SAS URLs. SAS signing uses Web Crypto, with no Azure SDK.
- `confirmUpload` checks the stored blob's size, content type and file signature
  (magic bytes) before a file is served, and deletes a blob that fails.
- Optional `md5` on `generateUploadUrl`: the ticket carries `Content-MD5`, so
  Azure refuses a different body, and confirmation rejects a missing or
  different checksum (`Checksum mismatch`). Not available with block uploads.
- Opt-in resumable block uploads (`blockUploads`) with owner-authorized
  `renewUploadUrl`. Confirmed block files are served from an immutable snapshot.
- Confirmation and its optional `onUpload` internal mutation commit atomically;
  repeated confirmations are safe.
- `eventGridHandler({ secret, onUpload? })` confirms uploads from Azure Event
  Grid `BlobCreated` events. The secret is compared in constant time, and events
  are ignored unless they come from the configured endpoint or the account's own
  blob host, container and prefix.
- Opt-in Defender for Storage malware scan gate: `onUpload` runs only after a
  clean verdict, with `scanning`, `rejected` and `scan_timed_out` statuses.
- Server-side `store` and `storeFromUrl` (Azure copy from an HTTPS URL), with
  the same size, type and signature checks.

### Reading and serving

- Read URLs signed per time window, with optional download file names and
  `Cache-Control` overrides, or a public or CDN base URL.
- `AzureBlob.read(ctx, fileId, { range? })` reads a ready file's bytes from an
  action, optionally a byte range.
- Access tier defaults, `setTier`, `rehydrate` and `refreshTier`; archived files
  are not served until rehydrated.
- File names, string metadata, and paginated listing per uploader.

### Deleting and cleanup

- Transactional `markForDeletion`, `purge`, and a `sweep` for abandoned uploads
  and failed deletes, with bounded concurrency, backlog draining, and
  exponential backoff for blobs that fail to delete.

### Authentication

- Shared account key, or Microsoft Entra client credentials with user delegation
  SAS for accounts that disable shared key access. Delegation keys are requested
  for 24 hours and cached; run `refreshUserDelegationKey` hourly. In Entra mode,
  SAS expiries are capped at the cached key's expiry.

### Safety limits

- `uploadTtlSeconds` and `readWindowSeconds` must be between 0 and 604800
  seconds; the constructor throws otherwise.
- Network failures talking to Azure throw
  `Azure Blob <operation> request failed` without the request URL or SAS.
  `checkSetup` results never contain a key, SAS, token or URL.

### Tooling

- `AzureBlob.checkSetup(ctx, { origin?, checksum? })` checks config,
  credentials, container and CORS, with fix hints.
- `clientApi()` for ready-made upload functions, and the `useUploadFile` React
  hook with progress, cancel, pause and resume. A file that confirmation rejects
  cannot be resumed; while paused, `progress` counts only stored blocks.
- Several containers and `pathPrefix` folders through one component.
- `convex-azure-blob-storage/test` helper for convex-test.
- Requires `convex` 1.46 or later; `react` 18.3.1 or 19 is optional.
