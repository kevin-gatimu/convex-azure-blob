# Event Grid upload confirmation

Confirm uploads from an Azure Event Grid subscription instead of the browser.
[Back to the README](../README.md)

The browser normally calls `confirmUpload` after Azure accepts a PUT. To recover
when the browser closes or loses its connection first, mount an Event Grid
handler in `convex/http.ts`:

```ts
const handler = azure.eventGridHandler({
  secret: process.env.AZURE_BLOB_EVENT_GRID_SECRET ?? "",
  onUpload: internal.photos.attach,
});

http.route({
  path: "/azure-blob/events",
  method: "POST",
  handler,
});
```

Set `AZURE_BLOB_EVENT_GRID_SECRET` in Convex before deploying the route. The
secret must be at least 32 characters; generate a random value rather than
choosing a password. This callback should match the `onUpload` used by
`clientApi`, so the browser and Event Grid confirm the same app record.

Generate and set a secret, then create a standard-schema Event Grid subscription
for the storage account:

```sh
secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
npx convex env set AZURE_BLOB_EVENT_GRID_SECRET "$secret"
resource_group="<resource-group>"
account="<storage-account>"
deployment="<deployment>"
account_id="$(az storage account show --name "$account" --resource-group "$resource_group" --query id -o tsv)"
az eventgrid event-subscription create \
  --name confirm-blob-uploads \
  --source-resource-id "$account_id" \
  --endpoint-type webhook \
  --endpoint "https://$deployment.convex.site/azure-blob/events?secret=$secret" \
  --included-event-types Microsoft.Storage.BlobCreated \
  --event-delivery-schema EventGridSchema
```

The handler answers Event Grid's subscription-validation handshake, confirms
tracked blobs through the same size, type, and signature checks as the browser,
and runs the configured `onUpload` mutation atomically. Duplicate events and
browser/event races are safe; unknown blobs, containers, and event types are
acknowledged without changes. Events are accepted only for blobs on the
configured endpoint's host or the account's own
`https://<account>.blob.core.windows.net` host, in the configured container and
prefix. Transient confirmation failures return HTTP 503 so Event Grid retries
them. Keep the endpoint on HTTPS. Query-string secrets can appear in URLs,
deployment settings, or access logs; restrict access to those records, avoid
logging the full request URL, and rotate the Convex secret and Event Grid
subscription endpoint together.
