# Several containers or folders

Spread files over several containers or folders.
[Back to the README](../README.md)

Create one client per container or folder. Each file remembers its container, so
reads and deletes go to the right place:

```ts
export const avatars = new AzureBlob(components.azureBlobStorage, {
  pathPrefix: "avatars", // blobs are named avatars/<uuid>.<ext>
  maxBytes: 1024 * 1024,
});

export const documents = new AzureBlob(components.azureBlobStorage, {
  config: { container: "documents" },
  allowedContentTypes: { "application/pdf": "pdf" },
});
```
