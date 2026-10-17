# Example: photo gallery

A small app that uses `convex-azure-blob`. It covers:

- `convex/convex.config.ts`: installs the component.
- `convex/photos.ts`: an `AzureBlob` client with a `photos/` prefix, upload
  functions from `clientApi` (with a quota check and an `onUpload` hook that
  records the photo), a list query with view and download URLs, and an
  owner-only delete that marks the file and purges its blob.
- `convex/crons.ts`: the hourly sweep.
- `convex/photos.test.ts`: testing all of the above with convex-test and Azure
  stubbed.
- `src/App.tsx`: uploads with `useUploadFile`, a progress bar and the gallery.

Run it from the repository root. See the "Example app" section of the main
README.
