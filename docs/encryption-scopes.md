# Encryption scopes

Encrypt new blobs with an existing Azure encryption scope.
[Back to the README](../README.md)

An
[Azure encryption scope](https://learn.microsoft.com/azure/storage/blobs/encryption-scope-overview)
encrypts blobs with a key of its own, so one storage account can keep each
customer's data under a separate key. Set `encryptionScope` and every new blob
this client writes lands in that scope:

```ts
export const azure = new AzureBlob(components.azureBlob, {
  encryptionScope: "customer-a",
});
```

- **The scope must already exist** on the storage account and be enabled; create
  it in the portal or with the Azure CLI. Scopes can use Microsoft-managed keys
  or customer-managed keys in Azure Key Vault. Names are 3-63 lowercase letters,
  digits and single dashes.
- **Only writes carry it.** Upload tickets, block staging and commit, `store`,
  and `storeFromUrl` are signed with the SAS `ses` field. With Microsoft Entra
  authentication the server-side writes send `x-ms-encryption-scope` instead.
  Read URLs, HEAD checks, tag reads, tier changes, and deletes don't use the
  scope, and Azure decrypts scoped blobs transparently while the scope is
  enabled.
- **Containers can enforce their own default scope.** If a container's default
  scope prohibits overrides, writes with a different scope fail with 403.
- **Existing blobs keep their scope.** Changing the option affects only new
  uploads.
- **Azurite caveat.** Azurite validates the `ses` signature but doesn't
  implement encryption scopes, so it neither encrypts nor rejects an unknown
  scope. Verify scoped uploads against a real storage account.
