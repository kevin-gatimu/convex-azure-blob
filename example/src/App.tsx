import "./App.css";
import { useUploadFile } from "convex-azure-blob/react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../convex/_generated/api";

const formatSize = (bytes?: number) =>
  bytes === undefined
    ? ""
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Uploader() {
  const { upload, cancel, progress, isUploading, error } = useUploadFile(
    api.photos,
  );
  const [lastName, setLastName] = useState<string | null>(null);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLastName(file.name);
    // Errors are also exposed as `error`; the gallery updates itself through `onUpload`.
    await upload(file).catch(() => undefined);
  };

  return (
    <section className="uploader">
      <label className="button">
        {isUploading ? "Uploading…" : "Upload a photo"}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          onChange={onChange}
          disabled={isUploading}
          hidden
        />
      </label>
      {isUploading && (
        <div className="progress">
          <progress
            value={progress ?? 0}
            max={1}
            aria-label={`Uploading ${lastName}`}
          />
          <button type="button" className="link" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {error && !isUploading && (
        <p className="error" role="alert">
          {lastName}: {error.message}
        </p>
      )}
      <p className="hint">
        JPEG, PNG, WebP, GIF or AVIF, up to 5 MB. Bytes go straight to Azure.
      </p>
    </section>
  );
}

function Gallery() {
  const photos = useQuery(api.photos.list);
  const remove = useMutation(api.photos.remove);

  if (photos === undefined) return <p className="hint">Loading…</p>;
  if (photos.length === 0) return <p className="hint">No photos yet.</p>;

  return (
    <ul className="gallery">
      {photos.map((photo) => (
        <li key={photo.id}>
          {photo.url ? (
            <img src={photo.url} alt={photo.fileName ?? ""} loading="lazy" />
          ) : (
            <div className="missing" />
          )}
          <div className="meta">
            <span title={photo.fileName}>{photo.fileName ?? "Untitled"}</span>
            <span>{formatSize(photo.size)}</span>
          </div>
          <div className="actions">
            {photo.downloadUrl && <a href={photo.downloadUrl}>Download</a>}
            <button
              type="button"
              className="link"
              onClick={() => void remove({ id: photo.id })}
            >
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  return (
    <main>
      <h1>Convex + Azure Blob Storage</h1>
      <p className="hint">
        Uploads use a five-minute, create-only SAS URL. Convex checks the blob's
        size, type and leading bytes before it is shown. See{" "}
        <code>example/convex/photos.ts</code>.
      </p>
      <Uploader />
      <Gallery />
    </main>
  );
}
