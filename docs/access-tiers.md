# Access tiers

Set blob access tiers, and read files that are archived or rehydrating.
[Back to the README](../README.md)

Set `accessTier: "Hot" | "Cool" | "Cold" | "Archive"` on `AzureBlob` to tier
files server-side after they become ready, including server uploads, Event Grid
confirmation, block commits, and clean malware scans. Upload tickets never
include tier headers. A failed automatic tier change leaves the file ready and
refreshes its actual tier from Azure; the failure is logged without a URL or
SAS.

```ts
const azure = new AzureBlob(components.azureBlobStorage, {
  accessTier: "Cool",
});
// Invoke from authorized actions, not queries or mutations.
await azure.setTier(ctx, fileId, "Archive");
await azure.rehydrate(ctx, fileId, { tier: "Hot", priority: "High" });
await azure.refreshTier(ctx, fileId); // poll from an internal action or cron
```

`getFile` and `list` expose optional `accessTier` and `archiveStatus`. The
`accessTier` and `archiveStatus` validators are exported for app validators.
`setTier`, `rehydrate`, and `refreshTier` return false for unknown or non-ready
files, and throw a `ConvexError` with the HTTP status on Azure non-2xx
responses, without including the request URL. `rehydrate` also throws when the
file's recorded tier is known and not `Archive`. Authorize callers and ownership
before invoking these server methods; they are not exposed by `clientApi`.

Archived files return null from both `getUrl` and `urlForFile`, even for public
containers. A 202 Accepted tier change keeps `accessTier: "Archive"` and records
`archiveStatus`, such as `"rehydrate-pending-to-hot"`; the file remains
unservable until `refreshTier` observes an online tier. Refresh reads
`x-ms-access-tier` and `x-ms-archive-status` from HEAD and clears the archive
status when absent. Refresh after external tier changes, too. Previously issued
URLs are not revoked by metadata updates. Standard-priority rehydration (the
default) can take **up to 15 hours**; High priority costs more and is not an
immediate-read guarantee.

Cool, Cold, and Archive have early-deletion charges for deleting or moving data
before **30, 90, and 180 days**, respectively. For age-based tiering, use Azure
Blob Storage **lifecycle management rules** instead of per-file actions. Not all
storage account types support every tier. Block uploads tier their immutable
snapshot, not the mutable staging blob; Azure cannot directly rehydrate an
archived snapshot, so recovering it requires copying to a new online blob
outside these methods. Avoid Archive for block uploads when in-place rehydration
is needed.

See Microsoft's
[Set Blob Tier REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-tier),
[Get Blob Properties](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob-properties),
[access tier pricing rules](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-overview),
and
[archive rehydration overview](https://learn.microsoft.com/en-us/azure/storage/blobs/archive-rehydrate-overview).
