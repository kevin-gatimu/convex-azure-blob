# Reading and listing files

Serve files through a CDN, read them from actions, and list files and their
metadata. [Back to the README](../README.md)

## Through a CDN or public container

Set `AZURE_BLOB_PUBLIC_BASE_URL` (for example `https://cdn.example.com/uploads`)
and `getUrl` returns `<base>/<blob name>` with no token. That makes URLs
permanent and easy to cache at the edge. Download URLs are still signed, since
they need a `Content-Disposition` override.

## Reading files from actions

`read` fetches a ready file's bytes inside an action, for thumbnails, parsing or
re-uploading. It returns a `Response`, or `null` if the file is unknown or not
`ready`. Check the caller's permission first.

```ts
export const thumbnail = action({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => {
    await requireUserInAction(ctx);
    const response = await azure.read(ctx, fileId);
    if (!response) return null;
    const image = new Uint8Array(await response.arrayBuffer());
    // ...resize, then azure.store(ctx, { data, contentType, uploadedBy })
  },
});

// Only the first kilobyte (end is inclusive); Azure answers 206.
const head = await azure.read(ctx, fileId, { range: { start: 0, end: 1023 } });
```

`start` must be a non-negative integer and `end`, if given, an integer no
smaller than `start`; otherwise `read` throws. Any other Azure status than 200
(206 when `range` is given) throws an error with the status only, never the URL
or SAS, and the returned `Response` has an empty `url`. The request uses a
one-minute read-only SAS (or your Entra token) against the internal endpoint, so
the bytes stream from Azure to the action, not through a browser URL.

## Listing files and metadata

```ts
export const myFiles = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUser(ctx);
    return await azure.list(ctx, { uploadedBy: userId, paginationOpts });
  },
});
```

`list` returns ready files, newest first, as a standard pagination result. Each
file has `fileId`, `container`, `blobName`, `contentType`, `size`, `maxBytes`,
`uploadedBy`, `fileName`, `metadata`, `status`, `createdAt` and
`uploadExpiresAt`.

Set a display name and string metadata at upload (`fileName`, `metadata`), or
later:

```ts
await azure.updateFile(ctx, fileId, { metadata: { alt: "A red bicycle" } });
```

Metadata is limited to 32 keys with values up to 1,024 characters. File names
are limited to 255 characters. The file name is never used in the blob path.
