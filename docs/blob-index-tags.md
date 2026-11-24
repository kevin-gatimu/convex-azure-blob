# Blob index tags

Tag blobs so lifecycle rules and searches can find them.
[Back to the README](../README.md)

Choose `tags?: Record<string, string>` server-side in `generateUploadUrl`,
`store`, or `storeFromUrl`. They are reserved on the file row, never included in
browser upload headers or `clientApi` arguments, and written to Azure only after
confirmation makes the file ready. This includes block uploads and Event Grid
confirmation; malware-gated files wait for a clean Defender verdict.

```ts
const ticket = await azure.generateUploadUrl(ctx, {
  contentType: "image/png",
  uploadedBy: userId,
  tags: { project: "gallery", retention: "temporary" },
});
// In an authorized action:
const tags = await azure.getTags(ctx, ticket.fileId);
await azure.setTags(ctx, ticket.fileId, { project: "gallery" });
```

`getTags` reads Azure's current tags, not the reserved row, and returns `null`
for unknown or non-ready files. `setTags` replaces only the app-managed keys
recorded in the row: omitted app keys are removed, other existing keys
(including Defender's scan-result tags) are preserved, and the new app values
win on overlap. Passing `{}` removes all app-managed keys. Azure replaces the
entire tag set, so these writes first GET existing tags and enforce the combined
ten-tag limit. Avoid managing Defender's keys yourself. Concurrent tag writers
should be serialized by the app; the GET/PUT merge is not atomic.

`setTags` returns `false` for unknown or non-ready files and updates the row
only after Azure accepts the write. Invalid tags and Azure failures throw a
`ConvexError`; non-2xx errors include the status, never the URL or SAS.
Automatic ready-time writes are best-effort: a failure is logged without
credentials and the file stays ready. The row retains the requested tags; use
`setTags` to retry. `updateFile` cannot set tags because it is a mutation, not
an action. Authorize callers in your app before exposing these action methods.

Tags need their own permission. With an account key the package signs the `t`
SAS permission itself. With Microsoft Entra, the identity needs the
`blobs/tags/read` and `blobs/tags/write` data actions: **Storage Blob Data
Owner** has them, **Storage Blob Data Contributor** does not. Without them Azure
answers `403 AuthorizationPermissionMismatch`; automatic writes log it and keep
the file ready, while `getTags` and `setTags` throw.

**Never put secrets in tags:** anyone with tag permission on the account or blob
can read them. Azure allows at most **10 tags**, with keys **1–128 characters**
and values **0–256 characters**, all case-sensitive strings. Allowed characters
are ASCII letters (`a-z`, `A-Z`), digits (`0-9`), space, plus, minus, period,
colon, equals, underscore, and forward slash (` +-.:=_/`). These limits apply to
the merged set, including Azure-managed tags.

Tags can drive Azure
[lifecycle management rules](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview)
and
[Find Blobs by Tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs).
For example, a filter can be `"project" = 'gallery' AND @container = 'uploads'`.
Find requires separate `f` permission (or appropriate RBAC), is eventually
consistent, and is not exposed by this package. Tag reads/writes use a
short-lived blob-scoped `t` service SAS, or Entra authorization; both service
and user-delegation SAS support `t`.

For block uploads, **tags target the base blob**, while reads still serve the
immutable snapshot. Azure's
[Set Blob Tags](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-tags)
supports snapshots since API 2020-08-04 and versions since 2019-12-12;
[Get Blob Tags](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob-tags)
also supports both. We deliberately use the base blob to share Defender's tag
resource and keep app tags discoverable by Azure's index and lifecycle rules.
Tags describe the base blob, not immutable snapshot content.
