"use client";

import { useAction, useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";
import { blockId, MAX_BLOCK_SIZE, MAX_BLOCKS } from "../client/blocks.js";

type UploadTicket = {
  fileId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  kind?: "blocks";
  blockSize?: number;
  expiresAt?: number;
};
type ConfirmResult =
  | { ok: true; size: number; contentType: string }
  | { ok: false; reason: string };

export type UploadOptions = {
  /** Headers from the upload ticket: `x-ms-blob-type` and `content-type`. */
  headers?: Record<string, string>;
  /** Called with the fraction uploaded, from 0 to 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

/** Thrown when the PUT to Azure fails, or the upload is rejected at confirm. */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** Stages sliced blocks with three workers; successful IDs can be retained for an in-memory retry. */
export async function uploadBlocksToAzure(
  ticket: UploadTicket,
  file: Blob,
  options: UploadOptions & { stagedBlockIds?: Set<string> } = {},
) {
  const blockSize = ticket.blockSize;
  if (
    !blockSize ||
    !Number.isSafeInteger(blockSize) ||
    blockSize <= 0 ||
    blockSize > MAX_BLOCK_SIZE ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    Math.ceil(file.size / blockSize) > MAX_BLOCKS
  )
    throw new UploadError("Invalid block upload ticket");
  const count = Math.ceil(file.size / blockSize);
  const staged = options.stagedBlockIds ?? new Set<string>();
  const pending: number[] = [];
  let completed = 0;
  for (let index = 0; index < count; index++) {
    if (staged.has(blockId(index)))
      completed += Math.min(blockSize, file.size - index * blockSize);
    else pending.push(index);
  }
  const inflight = new Map<number, number>();
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  options.signal?.addEventListener("abort", onAbort);
  if (options.signal?.aborted) abort.abort();
  const report = () => {
    if (!abort.signal.aborted)
      options.onProgress?.(
        Math.min(
          1,
          (completed +
            [...inflight.values()].reduce((sum, size) => sum + size, 0)) /
            file.size,
        ),
      );
  };
  let next = 0;
  let failure: unknown;
  report();
  const worker = async () => {
    try {
      while (next < pending.length) {
        abort.signal.throwIfAborted();
        const index = pending[next++]!;
        const id = blockId(index);
        const chunk = file.slice(
          index * blockSize,
          Math.min(file.size, (index + 1) * blockSize),
        );
        const url = new URL(ticket.uploadUrl);
        url.searchParams.set("comp", "block");
        url.searchParams.set("blockid", id);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          let settled = false;
          const stop = () => xhr.abort();
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            abort.signal.removeEventListener("abort", stop);
            inflight.delete(index);
            if (error) reject(error);
            else {
              staged.add(id);
              completed += chunk.size;
              report();
              resolve();
            }
          };
          xhr.open("PUT", url.toString());
          for (const [name, value] of Object.entries({
            ...ticket.headers,
            ...options.headers,
          }))
            if (name.toLowerCase() !== "x-ms-blob-type")
              xhr.setRequestHeader(name, value);
          xhr.upload.onprogress = (event) => {
            if (settled || abort.signal.aborted) return;
            inflight.set(
              index,
              Math.min(chunk.size, Math.max(0, event.loaded)),
            );
            report();
          };
          xhr.onload = () =>
            finish(
              xhr.status >= 200 && xhr.status < 300
                ? undefined
                : new UploadError(
                    `Upload failed with ${xhr.status}`,
                    xhr.status,
                  ),
            );
          xhr.onerror = () =>
            finish(
              new UploadError(
                "Upload failed: network error or CORS rule missing",
              ),
            );
          xhr.onabort = () =>
            finish(new DOMException("Upload aborted", "AbortError"));
          abort.signal.addEventListener("abort", stop);
          if (abort.signal.aborted)
            finish(new DOMException("Upload aborted", "AbortError"));
          else xhr.send(chunk);
        });
      }
    } catch (caught) {
      if (failure === undefined) failure = caught;
      abort.abort();
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(3, pending.length) }, worker),
    );
    if (failure !== undefined) throw failure;
    options.signal?.throwIfAborted();
    report();
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
/**
 * PUTs a file to an upload URL from `generateUploadUrl`. Uses XMLHttpRequest, since `fetch` does
 * not report upload progress.
 */
export function uploadToAzure(
  uploadUrl: string,
  file: Blob,
  options: UploadOptions = {},
) {
  return new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    xhr.open("PUT", uploadUrl);
    const headers = {
      "x-ms-blob-type": "BlockBlob",
      ...(file.type ? { "content-type": file.type } : {}),
      ...options.headers,
    };
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1);
        resolve();
      } else {
        reject(new UploadError(`Upload failed with ${xhr.status}`, xhr.status));
      }
    };
    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new UploadError("Upload failed: network error or CORS rule missing"),
      );
    };
    xhr.onabort = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Upload aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort);
    xhr.send(file);
  });
}

type GenerateArgs = { contentType: string; fileName?: string; size?: number };

/** The public functions `useUploadFile` calls, e.g. the ones `AzureBlob.clientApi()` returns. */
export type UploadApi<Args extends GenerateArgs> = {
  generateUploadUrl: FunctionReference<
    "mutation",
    "public",
    Args,
    UploadTicket
  >;
  confirmUpload: FunctionReference<
    "action",
    "public",
    { fileId: string },
    ConfirmResult
  >;
  renewUploadUrl?: FunctionReference<
    "mutation",
    "public",
    { fileId: string },
    UploadTicket
  >;
};

type ExtraArgs<Args> = Omit<Args, keyof GenerateArgs>;

/**
 * Uploads a file through your `generateUploadUrl` mutation and `confirmUpload` action and resolves
 * with the confirmed `fileId`.
 *
 * ```tsx
 * const { upload, progress, isUploading } = useUploadFile(api.files);
 * const fileId = await upload(file);
 * ```
 *
 * If your `generateUploadUrl` takes extra arguments (a post id, say), pass them as the second
 * argument of `upload`.
 * Block tickets support `pause()` and in-memory `resume()`; `cancel()` discards the session.
 * Resume renews unfinished staging tickets when `renewUploadUrl` is available.
 */
export function useUploadFile<Args extends GenerateArgs>(api: UploadApi<Args>) {
  const generateUploadUrl = useMutation(api.generateUploadUrl);
  const confirmUpload = useAction(api.confirmUpload);
  const renew = useMutation(
    api.renewUploadUrl ?? api.generateUploadUrl,
  ) as unknown as (args: { fileId: string }) => Promise<UploadTicket>;
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  type Session = { file: Blob; ticket: UploadTicket; staged: Set<string> };
  const session = useRef<Session | null>(null);
  const [canResume, setCanResume] = useState(false);

  useEffect(
    () => () => {
      const active = controller.current;
      controller.current = null;
      session.current = null;
      active?.abort();
    },
    [],
  );

  const transfer = useCallback(
    async (saved: Session, abort: AbortController) => {
      if (saved.ticket.kind === "blocks") {
        await uploadBlocksToAzure(saved.ticket, saved.file, {
          stagedBlockIds: saved.staged,
          onProgress: (fraction) => {
            if (controller.current === abort) setProgress(fraction);
          },
          signal: abort.signal,
        });
      } else {
        await uploadToAzure(saved.ticket.uploadUrl, saved.file, {
          headers: saved.ticket.headers,
          onProgress: (fraction) => {
            if (controller.current === abort) setProgress(fraction);
          },
          signal: abort.signal,
        });
      }
      abort.signal.throwIfAborted();
      const result = await confirmUpload({ fileId: saved.ticket.fileId });
      abort.signal.throwIfAborted();
      if (!result.ok) throw new UploadError(result.reason);
      if (session.current === saved) {
        session.current = null;
        setCanResume(false);
      }
      return saved.ticket.fileId;
    },
    [confirmUpload],
  );

  const upload = useCallback(
    async (
      file: File | Blob,
      ...extra: object extends ExtraArgs<Args>
        ? [ExtraArgs<Args>?]
        : [ExtraArgs<Args>]
    ) => {
      controller.current?.abort();
      session.current = null;
      setCanResume(false);
      const abort = new AbortController();
      controller.current = abort;
      setError(null);
      setProgress(0);
      setIsUploading(true);
      try {
        const args = {
          ...extra[0],
          contentType: file.type,
          size: file.size,
          ...(file instanceof File ? { fileName: file.name } : {}),
        } as unknown as Args;
        // `Args` is generic, so TypeScript cannot see it as `generateUploadUrl`'s single argument.
        const ticket = await (
          generateUploadUrl as unknown as (args: Args) => Promise<UploadTicket>
        )(args);
        const saved = { ticket, file, staged: new Set<string>() };
        if (controller.current === abort) session.current = saved;
        abort.signal.throwIfAborted();
        return await transfer(saved, abort);
      } catch (caught) {
        const failure =
          caught instanceof Error ? caught : new Error(String(caught));
        if (controller.current === abort) {
          setError(failure);
          setCanResume(session.current?.ticket.kind === "blocks");
        }
        throw failure;
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          setIsUploading(false);
          if (session.current?.ticket.kind !== "blocks") setProgress(null);
        }
      }
    },
    [generateUploadUrl, transfer],
  );

  const pause = useCallback(() => controller.current?.abort(), []);
  const cancel = useCallback(() => {
    session.current = null;
    setCanResume(false);
    setProgress(null);
    const active = controller.current;
    controller.current = null;
    setIsUploading(false);
    active?.abort();
  }, []);
  const resume = useCallback(async (): Promise<string> => {
    const saved = session.current;
    if (!saved || saved.ticket.kind !== "blocks" || controller.current)
      throw new UploadError("No paused upload");
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setProgress(0);
    setIsUploading(true);
    setCanResume(false);
    try {
      if (
        saved.staged.size ===
        Math.ceil(saved.file.size / saved.ticket.blockSize!)
      ) {
        const result = await confirmUpload({ fileId: saved.ticket.fileId });
        abort.signal.throwIfAborted();
        if (result.ok) {
          session.current = null;
          setCanResume(false);
          return saved.ticket.fileId;
        }
        if (result.reason !== "Upload expired")
          throw new UploadError(result.reason);
      }
      if (api.renewUploadUrl) {
        const ticket = await renew({ fileId: saved.ticket.fileId });
        abort.signal.throwIfAborted();
        if (
          ticket.fileId !== saved.ticket.fileId ||
          ticket.kind !== "blocks" ||
          ticket.blockSize !== saved.ticket.blockSize ||
          new URL(ticket.uploadUrl).origin !==
            new URL(saved.ticket.uploadUrl).origin ||
          new URL(ticket.uploadUrl).pathname !==
            new URL(saved.ticket.uploadUrl).pathname
        )
          throw new UploadError("Renewed upload ticket does not match");
        saved.ticket = ticket;
      }
      return await transfer(saved, abort);
    } catch (caught) {
      const failure =
        caught instanceof Error ? caught : new Error(String(caught));
      if (controller.current === abort) {
        setError(failure);
        setCanResume(session.current === saved);
      }
      throw failure;
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setIsUploading(false);
        if (session.current?.ticket.kind !== "blocks") setProgress(null);
      }
    }
  }, [api.renewUploadUrl, renew, transfer, confirmUpload]);

  return {
    upload,
    pause,
    resume,
    cancel,
    canResume,
    progress,
    isUploading,
    error,
  };
}
