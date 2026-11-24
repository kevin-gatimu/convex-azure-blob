# Local development and testing

Run against Azurite locally, and test the code in your app.
[Back to the README](../README.md)

## Local development with Azurite

[Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)
emulates Blob Storage and validates SAS signatures the way Azure does. It does
not implement the Get User Delegation Key REST API or Entra OAuth, so
user-delegation authentication is covered by mocked tests and must be verified
against an Azure storage account.

```sh
docker run -d -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
  azurite-blob --blobHost 0.0.0.0 --loose
```

Create a container and a CORS rule for your dev server. This repository has a
script for that, `scripts/azurite-setup.mjs`. Then point Convex at it:

```sh
npx convex env set AZURE_BLOB_ACCOUNT devstoreaccount1
npx convex env set AZURE_BLOB_KEY 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
npx convex env set AZURE_BLOB_CONTAINER uploads
npx convex env set AZURE_BLOB_ENDPOINT http://127.0.0.1:10000/devstoreaccount1
```

That key is Azurite's published development key. It is not a secret and only
works with the emulator. A cloud Convex deployment cannot reach `127.0.0.1`, so
choose a local deployment when `npx convex dev` asks, or expose Azurite through
a tunnel.

## Testing your app

Register the component with
[convex-test](https://docs.convex.dev/testing/convex-test) and stub `fetch` for
the Azure calls:

```ts
import azureBlobTest from "convex-azure-blob-storage/test";
import { convexTest } from "convex-test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function initConvexTest() {
  const t = convexTest(schema, modules);
  azureBlobTest.register(t); // pass a name if you installed it under another one
  return t;
}
```

See [`example/convex/photos.test.ts`](../example/convex/photos.test.ts) for a
complete test with Azure stubbed.

## Running the example against live Azure

For live Azure with Entra authentication, use the
[Entra setup guide](./entra.md). The storage account's **Blob service CORS**
rule must include the exact frontend origin, such as `http://localhost:5173`
(and a different origin if Vite chooses a different port). Allow
`PUT, GET, HEAD, OPTIONS`, the headers in the
[CORS prerequisites](./azure-setup.md#an-azure-storage-account), and expose
`etag`. A successful server-side integration test does not prove browser CORS is
configured. The UI reports network/CORS failures per file instead of silently
dropping a batch; after fixing the rule, resume the failed transfer.
