# Microsoft Entra user-delegation SAS

Sign uploads and reads with Microsoft Entra instead of an account key.
[Back to the README](../README.md)

Use these steps to configure a test storage account and Microsoft Entra
application for user-delegation SAS. Use a dedicated test account/container, not
production.

## 1. Register a single-tenant app

In the [Microsoft Entra admin center](https://entra.microsoft.com), go to
**Entra ID → App registrations → New registration**:

1. Enter a name, for example `convex-azure-blob-storage-test`.
2. Leave **Supported account types** set to **Accounts in this organizational
   directory only (Single tenant)**.
3. Leave **Redirect URI** blank; this server-to-server client-credentials flow
   does not use a redirect.
4. Select **Register**.

From the app's **Overview** page, save the **Directory (tenant) ID** and
**Application (client) ID**. These are configuration values, not secrets.

## 2. Create a client secret

Open **Certificates & secrets → Client secrets → New client secret**. Add a
description and choose an expiry, then select **Add**. Copy the secret's
**Value** immediately; it is only shown once. Store it securely and never commit
it, put it in a screenshot, or paste it into chat.

## 3. Prepare the storage account

Use a general-purpose v2 storage account and create a private blob container for
testing, such as `convex-test`. On the storage account's **Security** settings:

- Leave **Require secure transfer for REST API operations** enabled.
- Leave anonymous container access disabled.
- Clear **Enable storage account key access**. This is the setting that ensures
  the test exercises Entra authorization rather than account-key auth.
- Keeping the minimum TLS version at 1.2 is recommended.

The portal's **Default to Microsoft Entra authorization** option only changes
the portal's default sign-in behavior; it does not grant the app access. Azure
RBAC role assignments below grant that access.

For uploads from the example's browser, also configure the storage account's
**Resource sharing (CORS) → Blob service** rule for `http://localhost:5173`,
including allowed upload headers, then **Save**. Follow the exact
[local CORS values above](./azure-setup.md#an-azure-storage-account). This
browser requirement is separate from Entra app roles and is easy to miss when
server-side tests pass.

## 4. Assign the app's Azure roles

For **Storage Blob Delegator**, open the storage account's **Access control
(IAM) → Add → Add role assignment** and choose the **Storage Blob Delegator**
role. Assign it at the **storage account** scope; this role allows the app to
request user-delegation keys.

For **Storage Blob Data Contributor**, open the test container's **Access
control (IAM) → Add → Add role assignment** and choose that role. This grants
blob read, write, and delete access to the test container only. If container
scope is unavailable, assign it from the storage account's IAM page instead,
which grants access to all containers in that account.

For both assignments, select **User, group, or service principal** under
**Assign access to** (not **Managed identity**), then select the app
registration you created. In the member picker it may appear as an
**Application**; confirm the app appears in the Members table before continuing.
Do not proceed if the review page says **No members selected**. Select
**Review + assign**, verify the role, scope, and app member, then select
**Review + assign** again to submit. Allow a few minutes for role assignments to
propagate before testing.

## 5. Configure the Convex development deployment

From your project directory, set the account name, endpoint, container, tenant
ID, and client ID on the **development** deployment:

```sh
npx convex env set AZURE_BLOB_ACCOUNT '<storage-account-name>'
npx convex env set AZURE_BLOB_ENDPOINT 'https://<storage-account-name>.blob.core.windows.net'
npx convex env set AZURE_BLOB_CONTAINER '<test-container-name>'
npx convex env set AZURE_BLOB_TENANT_ID '<directory-tenant-id>'
npx convex env set AZURE_BLOB_CLIENT_ID '<application-client-id>'
```

Set the client secret interactively so it is not included in the command or
shell history:

```sh
npx convex env set AZURE_BLOB_CLIENT_SECRET
```

Do not set `AZURE_BLOB_KEY` for this test. If it is already set on this
development deployment, remove it:

```sh
npx convex env remove AZURE_BLOB_KEY
```

You can optionally set `AZURE_BLOB_AUTHORITY_HOST` for a sovereign cloud; the
default is `https://login.microsoftonline.com`. If `AZURE_BLOB_KEY` is set,
account-key auth takes precedence and Entra credentials are not used.

The two role scopes above are intentionally different: **Storage Blob
Delegator** must be assigned at the storage account, resource group, or
subscription scope; **Storage Blob Data Contributor** can be scoped to the
container. See Microsoft's docs for
[user-delegation SAS permissions](https://learn.microsoft.com/azure/storage/blobs/storage-blob-user-delegation-sas-create)
and
[Get User Delegation Key](https://learn.microsoft.com/rest/api/storageservices/get-user-delegation-key).

The example's `refreshUserDelegationKey` internal action is scheduled hourly and
refreshes the key when it has less than twelve hours remaining. Run the action
once from the Convex dashboard after deployment to initialize the cache; uploads
and signed read URLs fail with a clear error until a valid key is cached. Keys
are valid for 24 hours. In Entra mode, upload and read SAS expiries are capped
at the cached key's expiry, so a long `uploadTtlSeconds` (for block uploads) can
be cut to as little as about 12 hours; renew with `renewUploadUrl`. Refresh
hourly: with a daily schedule the key expires a few minutes before the next run.

The cached delegation key is a signing secret stored in the component table.
Treat access to the Convex deployment and its component data as privileged.
Azure's **Revoke User Delegation Keys** operation invalidates the cached key and
all SAS URLs signed with delegation keys; the cron must obtain a new key before
Entra-backed SAS operations can continue. The routine refresh keeps a cached key
that is still valid, so after revoking, force a replacement. Check the
revocation first, then run the example action with `force`:

```sh
npx convex run photos:refreshUserDelegationKey '{"force":true}'
```

`refreshUserDelegationKey(ctx, { force: true })` skips the cached key and stores
the replacement. If the forced request fails, the cached key is kept and the
error is thrown. Uploads that were in flight need a fresh upload URL.

Pre-release deployments may contain file records created before
`uploadExpiresAt` was stored. These records remain valid and are not rewritten;
cleanup uses the file's creation time plus the configured upload TTL, with a
one-hour minimum, as a conservative expiry fallback.
