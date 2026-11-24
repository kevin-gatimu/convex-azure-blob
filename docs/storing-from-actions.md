# Storing files from actions

Upload bytes you already have from an action. [Back to the README](../README.md)

Upload bytes you already have (an import, a generated PDF, a migration from
Convex file storage):

```ts
export const importAvatar = internalAction({
  args: { url: v.string(), userId: v.string() },
  handler: async (ctx, { url, userId }) => {
    const response = await fetch(url);
    const result = await azure.store(ctx, {
      data: await response.blob(), // Blob, ArrayBuffer or Uint8Array
      contentType: response.headers.get("content-type") ?? "",
      uploadedBy: userId,
      fileName: "avatar",
    });
    if (!result.ok) throw new Error(result.reason);
    return result.fileId;
  },
});
```

`store` runs the same checks as a browser upload.

When a source is already available at an HTTPS URL, Azure can fetch it directly
without passing the bytes through the Convex action:

```ts
const result = await azure.storeFromUrl(ctx, {
  sourceUrl,
  contentType: "image/png",
  uploadedBy: userId,
  fileName: "avatar",
  maxBytes: 5 * 1024 * 1024,
});
if (!result.ok) throw new Error(result.reason);
return result.fileId;
```

`storeFromUrl` accepts only HTTPS source URLs and applies the same size,
content-type and file-signature checks as `store`. The source must be publicly
readable or include a read SAS, and must return a valid `Content-Length`. Source
URLs are limited to 2 KiB. Azure's synchronous operation is limited to 5,000
MiB; an oversized source or one without a valid length is rejected. Azure
fetches the source URL itself, so treat user-supplied URLs as an SSRF risk:
validate them against your application's trusted-source policy before calling
this method. HTTPS alone does not make an arbitrary URL safe. Do not log source
URLs that contain SAS tokens.
