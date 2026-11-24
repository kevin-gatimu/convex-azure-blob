# Guides

One guide per feature. The [README](../README.md) covers setup and the basic
upload, serve and delete flow.

- [Azure setup](./azure-setup.md): the storage account, CORS, and `checkSetup`.
- [Microsoft Entra](./entra.md): sign with an app registration instead of a key.
- [Uploads in depth](./uploads.md): large and resumable uploads, MD5, custom
  upload functions, allowed types and sizes.
- [Event Grid confirmation](./event-grid.md): confirm uploads from Azure instead
  of the browser.
- [Malware scanning](./malware-scanning.md): hold files until Defender for
  Storage clears them.
- [Access tiers](./access-tiers.md): hot, cool, cold and archive blobs.
- [Reading and listing](./reading-and-listing.md): CDN, reads from actions,
  listing and metadata.
- [Deleting and the sweep](./deleting-and-sweep.md): retention, retries and
  sweep tuning.
- [Storing from actions](./storing-from-actions.md): upload bytes you already
  have.
- [Encryption scopes](./encryption-scopes.md): encrypt new blobs with an Azure
  scope.
- [Containers and prefixes](./containers-and-prefixes.md): several containers or
  folders.
- [Testing](./testing.md): Azurite and testing your app.
- [Blob index tags](./blob-index-tags.md): tag blobs for lifecycle rules and
  search.
- [API reference](./api.md): the `AzureBlob` class, the React hook and the
  lower-level exports.
