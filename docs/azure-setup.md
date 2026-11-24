# Azure setup

Create and configure the storage account, then check that the setup works.
[Back to the README](../README.md)

## An Azure storage account

1. Create a storage account and a **private** container (no anonymous access).
   [Azure portal guide](https://learn.microsoft.com/azure/storage/blobs/storage-quickstart-blobs-portal).
2. Copy an access key from **Security + networking → Access keys**.
3. Add a CORS rule for your app's origins under **Settings → Resource sharing
   (CORS) → Blob service**:

   | Allowed origins          | Allowed methods           | Allowed headers                                                                 | Exposed headers                      | Max age |
   | ------------------------ | ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ | ------- |
   | `https://your.app` (etc) | `GET, HEAD, PUT, OPTIONS` | `x-ms-blob-type, content-type, x-ms-version, x-ms-client-request-id, x-ms-date` | `etag, content-length, content-type` | `3600`  |

   Or with the Azure CLI:

   ```sh
   az storage cors add --services b --account-name <account> \
     --origins https://your.app --methods GET HEAD PUT OPTIONS \
     --allowed-headers 'x-ms-blob-type,content-type,x-ms-version,x-ms-client-request-id,x-ms-date' \
     --exposed-headers 'etag,content-length,content-type' --max-age 3600
   ```

   **For this example:** use the exact origin `http://localhost:5173`, without a
   trailing slash. In the Azure portal, select the **Blob service** tab, fill in
   **Allowed headers** as well as the origin and methods, and select **Save**.
   Adding just the origin is not enough: a rule can allow ordinary `GET` and
   headerless `PUT` requests while rejecting the browser's upload preflight.
   `content-type` and `x-ms-version` must be allowed for block uploads.

   If an upload reports a network/CORS error, confirm these fields on the same
   rule:

   | Field           | Local example value                                                             |
   | --------------- | ------------------------------------------------------------------------------- |
   | Allowed origins | `http://localhost:5173`                                                         |
   | Allowed methods | `GET, HEAD, PUT, OPTIONS`                                                       |
   | Allowed headers | `content-type, x-ms-version, x-ms-blob-type, x-ms-client-request-id, x-ms-date` |
   | Exposed headers | `etag, content-length, content-type`                                            |
   | Max age         | `3600`                                                                          |

   RBAC permissions do not replace CORS. After saving, resume the failed upload.
   Preserve any existing CORS rules for other applications.

For local development, use
[Azurite](./testing.md#local-development-with-azurite) instead. Once the
variables are set, [check your setup](#checking-your-setup) to catch a wrong
key, a missing role, a missing container, or a CORS rule that blocks uploads.

## Checking your setup

`checkSetup` verifies the configuration from an action and reports one entry per
check, each with a fix hint when it fails:

```ts
export const checkSetup = internalAction({
  args: { origin: v.optional(v.string()), checksum: v.optional(v.boolean()) },
  handler: async (ctx, args) => await azure.checkSetup(ctx, args),
});
```

Run it from the Convex dashboard, or
`npx convex run photos:checkSetup '{"origin":"http://localhost:5173"}'` in the
example app.

| Check         | Passes when                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `config`      | the required environment variables resolve (the hint names the missing ones)                                   |
| `credentials` | Azure accepts a signed request (shared key), or a Microsoft Entra token and a user delegation key are obtained |
| `container`   | a read probe for a random blob name answers `BlobNotFound`, so the container exists and the identity can read  |
| `cors`        | with `origin`, a `PUT` preflight for the headers the uploader sends is allowed on the endpoint browsers use    |

A check is skipped, with the hint `skipped: <check> failed`, when an earlier one
it depends on fails. The Entra check only verifies that a delegation key can be
requested; it does not cache it, so run `refreshUserDelegationKey` separately.
In Entra mode the container probe uses a 60-second user-delegation SAS, so a
wrong `AZURE_BLOB_ACCOUNT` fails the `credentials` check. A malformed
`AZURE_BLOB_KEY` also fails `credentials`, not as an unreachable endpoint.

The `cors` preflight asks for `x-ms-blob-type` and `content-type`; with
`blockUploads` it asks for `content-type` only, and `checksum: true` (uploads
that send an `md5`) adds `content-md5` unless `blockUploads` is on, since block
uploads don't support `md5`. Azure answers a bad signature or a storage account
firewall block as `AuthorizationFailure`, so that hint names the account key,
the clock, and the firewall or network rules (for example Convex's egress). The
result never contains the key, a SAS, a token, or a URL.
