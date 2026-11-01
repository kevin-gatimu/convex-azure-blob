import "./App.css";
import { useUploadFile } from "convex-azure-blob/react";
import { useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../convex/_generated/api";
import {
  ACCEPT_FILES,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_BYTES,
  normalizeFile,
} from "../upload-policy";

type UploadStatus =
  "queued" | "uploading" | "paused" | "failed" | "complete" | "cancelled";
type QueueItem = { id: number; file: File; status: UploadStatus };
type UploadControl = { start: () => Promise<void> };

const formatSize = (bytes = 0): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
};

function UploadRow({
  item,
  connected,
  register,
  onStatus,
}: {
  item: QueueItem;
  connected: boolean;
  register: (id: number, control: UploadControl | null) => void;
  onStatus: (id: number, status: UploadStatus) => void;
}) {
  const { upload, progress, isUploading, pause, resume, cancel, canResume } =
    useUploadFile(api.photos);
  const [failure, setFailure] = useState<string | null>(null);
  const interruption = useRef<"paused" | "cancelled" | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (resuming = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      interruption.current = null;
      setFailure(null);
      onStatus(item.id, "uploading");
      try {
        if (resuming) await resume();
        else await upload(item.file);
        onStatus(item.id, "complete");
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        if (interruption.current) {
          onStatus(item.id, interruption.current);
        } else {
          setFailure(message);
          onStatus(item.id, "failed");
        }
      } finally {
        inFlight.current = false;
      }
    },
    [item.id, item.file, upload, resume, onStatus],
  );

  useEffect(() => {
    register(item.id, { start: () => run() });
    return () => register(item.id, null);
  }, [register, item.id, run]);

  return (
    <li className={`queue-row ${item.status}`}>
      <div className="file-icon" aria-hidden="true">
        {item.file.name.split(".").at(-1)?.toUpperCase().slice(0, 4) ?? "FILE"}
      </div>
      <div className="queue-details">
        <strong title={item.file.name}>{item.file.name}</strong>
        <span className="hint">
          {formatSize(item.file.size)} <span aria-hidden="true"> / </span>
          {item.status === "complete" ? "Uploaded and verified" : item.status}
        </span>
        {isUploading && (
          <>
            <progress
              value={progress ?? 0}
              max={1}
              aria-label={`Uploading ${item.file.name}`}
            />
            <span className="hint">
              {(progress ?? 0) >= 1
                ? "Verifying with Convex..."
                : `${Math.round((progress ?? 0) * 100)}% uploaded`}
            </span>
          </>
        )}
        {failure && (
          <p className="error" role="alert">
            {failure}
            {/network|cors/i.test(failure) &&
              " Check the Blob service CORS rule: allow http://localhost:5173, PUT/GET/HEAD/OPTIONS, and content-type/x-ms-version headers."}
          </p>
        )}
      </div>
      <div className="queue-actions">
        {isUploading && (progress ?? 0) < 1 && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              interruption.current = "paused";
              pause();
            }}
          >
            Pause
          </button>
        )}
        {canResume &&
          !isUploading &&
          item.status !== "complete" &&
          item.status !== "cancelled" && (
            <button
              type="button"
              className="secondary"
              disabled={!connected}
              onClick={() => void run(true)}
            >
              Resume
            </button>
          )}
        {["failed", "paused"].includes(item.status) && !canResume && (
          <button
            type="button"
            className="secondary"
            disabled={!connected}
            onClick={() => void run()}
          >
            Retry
          </button>
        )}
        {["queued", "uploading", "paused", "failed"].includes(item.status) && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              interruption.current = "cancelled";
              cancel();
              onStatus(item.id, "cancelled");
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

function Uploader({ connected }: { connected: boolean }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectionError, setSelectionError] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const batchActive = useRef(false);
  const sequence = useRef(0);
  const controls = useRef(new Map<number, UploadControl>());
  const cancelled = useRef(new Set<number>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const register = useCallback((id: number, control: UploadControl | null) => {
    if (control) controls.current.set(id, control);
    else controls.current.delete(id);
  }, []);
  const onStatus = useCallback((id: number, status: UploadStatus) => {
    if (status === "cancelled") cancelled.current.add(id);
    if (alive.current)
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, status } : item)),
      );
  }, []);

  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    const accepted: QueueItem[] = [];
    const rejected: string[] = [];
    for (const selected of files) {
      const file = normalizeFile(selected);
      if (!ALLOWED_CONTENT_TYPES[file.type]) {
        rejected.push(`${file.name}: this file type is not supported.`);
      } else if (file.size === 0) {
        rejected.push(`${file.name}: empty files cannot be uploaded.`);
      } else if (file.size > MAX_FILE_BYTES) {
        rejected.push(
          `${file.name}: exceeds Azure's 190.7 TiB block-blob limit.`,
        );
      } else {
        accepted.push({ id: ++sequence.current, file, status: "queued" });
      }
    }
    setSelectionError(rejected);
    setItems((current) => [...current, ...accepted]);
  };

  const startBatch = async () => {
    if (batchActive.current) return;
    batchActive.current = true;
    setRunning(true);
    try {
      for (const item of items) {
        if (!alive.current) break;
        if (item.status !== "queued" || cancelled.current.has(item.id))
          continue;
        const control = controls.current.get(item.id);
        if (!control) {
          onStatus(item.id, "failed");
          setSelectionError((current) => [
            ...current,
            `${item.file.name}: uploader is unavailable; reselect this file.`,
          ]);
          continue;
        }
        await control.start();
      }
    } finally {
      batchActive.current = false;
      if (alive.current) setRunning(false);
    }
  };
  const queued = items.filter((item) => item.status === "queued").length;
  const complete = items.filter((item) => item.status === "complete").length;

  return (
    <section className="panel uploader" aria-labelledby="upload-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">01 / UPLOAD</p>
          <h2 id="upload-heading">Your files, straight to Azure.</h2>
          <p className="hint">
            Select one file or a batch. Each file is verified before it appears
            in your library.
          </p>
        </div>
        <span className="badge">Resumable blocks</span>
      </div>
      <div className="upload-zone">
        <div className="upload-symbol" aria-hidden="true">
          +
        </div>
        <h3>Small files. Big ideas.</h3>
        <p>Images, documents, archives, audio, and video.</p>
        <div className="selection-buttons">
          <label className="button">
            Choose one file
            <input
              type="file"
              aria-label="Choose one file"
              accept={ACCEPT_FILES}
              onChange={select}
              disabled={running}
              className="file-input"
            />
          </label>
          <label className="button secondary">
            Choose multiple files
            <input
              type="file"
              aria-label="Choose multiple files"
              accept={ACCEPT_FILES}
              multiple
              onChange={select}
              disabled={running}
              className="file-input"
            />
          </label>
        </div>
        <p className="hint">
          JPG, PNG, WebP, GIF, AVIF, PDF, ZIP, MP4, WebM, MP3
        </p>
      </div>
      <p className="hint upload-note">
        Files are sent in chunks, not loaded into memory all at once. Pause or
        resume in this tab; refreshing clears unfinished upload sessions. Azure
        service limits and your connection still apply.
      </p>
      {selectionError.map((message) => (
        <p className="error" role="alert" key={message}>
          {message}
        </p>
      ))}
      {items.length > 0 && (
        <>
          <div className="queue-heading">
            <h3>
              Upload queue{" "}
              <span className="hint">
                {complete}/{items.length} verified
              </span>
            </h3>
            <div className="selection-buttons">
              <button
                type="button"
                className="button"
                disabled={!connected || running || queued === 0}
                onClick={() => void startBatch()}
              >
                {running
                  ? "Uploading batch..."
                  : queued === 0
                    ? "No files queued"
                    : `Upload ${queued === 1 ? "file" : `${queued} files`}`}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={
                  running || items.some((item) => item.status === "uploading")
                }
                onClick={() =>
                  setItems((current) =>
                    current.filter(
                      (item) =>
                        !["complete", "cancelled"].includes(item.status),
                    ),
                  )
                }
              >
                Clear finished
              </button>
            </div>
          </div>
          <ul className="upload-queue">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                connected={connected}
                register={register}
                onStatus={onStatus}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Gallery({ connected }: { connected: boolean }) {
  const files = useQuery(api.photos.list);
  const remove = useMutation(api.photos.remove);
  const [deleting, setDeleting] = useState(new Set<string>());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState(new Set<string>());

  const deleteFile = async (id: NonNullable<typeof files>[number]["id"]) => {
    setDeleteError(null);
    setDeleting((current) => new Set(current).add(id));
    try {
      await remove({ id });
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <section className="library" aria-labelledby="library-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">02 / FILE LIBRARY</p>
          <h2 id="library-heading">Stored in Azure. Synced by Convex.</h2>
        </div>
        <span className="badge">{files?.length ?? 0} files</span>
      </div>
      {deleteError && (
        <p className="error" role="alert">
          Delete failed: {deleteError}
        </p>
      )}
      {files === undefined ? (
        <div className="empty-state" role="status">
          {connected
            ? "Loading your library..."
            : "Waiting for the Convex backend. Start npm run dev in the repository root."}
        </div>
      ) : files.length === 0 ? (
        <div className="empty-state">
          <span className="empty-symbol" aria-hidden="true">
            [ ]
          </span>
          <h3>A clean slate for your next upload.</h3>
          <p className="hint">
            Upload a file above. Confirmed metadata appears here in real time.
          </p>
        </div>
      ) : (
        <ul className="gallery">
          {files.map((file) => (
            <li key={file.id}>
              {file.url &&
              file.contentType?.startsWith("image/") &&
              !brokenImages.has(file.id) ? (
                <img
                  src={file.url}
                  alt={file.fileName ?? "Uploaded image"}
                  loading="lazy"
                  onError={() =>
                    setBrokenImages((current) => new Set(current).add(file.id))
                  }
                />
              ) : (
                <div className="document-preview">
                  <span>
                    {file.fileName
                      ?.split(".")
                      .at(-1)
                      ?.toUpperCase()
                      .slice(0, 5) ?? "FILE"}
                  </span>
                  <small>
                    {brokenImages.has(file.id)
                      ? "Preview unavailable"
                      : (file.contentType ?? "File")}
                  </small>
                </div>
              )}
              <div className="file-meta">
                <strong title={file.fileName}>
                  {file.fileName ?? "Untitled"}
                </strong>
                <p className="hint">
                  {formatSize(file.size)}{" "}
                  <span className="verified">Verified</span>
                </p>
              </div>
              <div className="actions">
                {file.url && (
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    View file
                  </a>
                )}
                {file.downloadUrl ? (
                  <a href={file.downloadUrl}>Download file</a>
                ) : (
                  <span className="hint">Download unavailable</span>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={!connected || deleting.has(file.id)}
                  onClick={() => void deleteFile(file.id)}
                >
                  {deleting.has(file.id) ? "Deleting..." : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function App() {
  const { isWebSocketConnected } = useConvexConnectionState();
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>{" "}
          convex-azure-blob
        </a>
        <div
          className={`connection ${isWebSocketConnected ? "online" : ""}`}
          role="status"
        >
          <span aria-hidden="true" />
          {isWebSocketConnected ? "Convex connected" : "Convex reconnecting"}
        </div>
      </header>
      <section className="hero" id="top">
        <p className="eyebrow">THE CONVEX + AZURE BLOB STORAGE DEMO</p>
        <h1>
          Big files.
          <br />
          <span>Small backend.</span>
        </h1>
        <p className="hero-copy">
          Azure stores the bytes. Convex keeps everything in sync. Upload one
          file or a whole batch without routing file data through your backend.
        </p>
        <div className="hero-tags">
          <span>No Azure SDK</span>
          <span>Short-lived SAS</span>
          <span>Live metadata</span>
        </div>
      </section>
      <div className="how-it-works" aria-label="How uploads work">
        <article>
          <span className="step">1</span>
          <h3>Get permission</h3>
          <p>
            Convex authorizes an upload and issues a short-lived, file-scoped
            SAS.
          </p>
        </article>
        <article>
          <span className="step">2</span>
          <h3>Send direct</h3>
          <p>
            Your browser stages resumable blocks directly in private Azure
            storage.
          </p>
        </article>
        <article>
          <span className="step">3</span>
          <h3>Verify &amp; sync</h3>
          <p>
            Convex checks size, type, and signature, then publishes the verified
            file.
          </p>
        </article>
      </div>
      {!isWebSocketConnected && (
        <p className="connection-warning" role="alert">
          Uploads are unavailable while Convex is disconnected. Run{" "}
          <code>npm run dev</code> and check your <code>VITE_CONVEX_URL</code>.
        </p>
      )}
      <Uploader connected={isWebSocketConnected} />
      <Gallery connected={isWebSocketConnected} />
      <footer>
        <p>
          This is a shared demo, not a private account. Visitors without sign-in
          share the same library. Do not upload sensitive files.
        </p>
        <a
          href="https://github.com/kevin-gatimu/convex-azure-blob"
          target="_blank"
          rel="noreferrer"
        >
          Explore the component on GitHub
        </a>
      </footer>
    </main>
  );
}
