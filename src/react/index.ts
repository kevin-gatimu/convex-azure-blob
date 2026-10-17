"use client";

import { useAction, useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";

type UploadTicket = {
  fileId: string;
  uploadUrl: string;
  headers: Record<string, string>;
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
 */
export function useUploadFile<Args extends GenerateArgs>(api: UploadApi<Args>) {
  const generateUploadUrl = useMutation(api.generateUploadUrl);
  const confirmUpload = useAction(api.confirmUpload);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      const active = controller.current;
      controller.current = null;
      active?.abort();
    },
    [],
  );

  const upload = useCallback(
    async (
      file: File | Blob,
      ...extra: object extends ExtraArgs<Args>
        ? [ExtraArgs<Args>?]
        : [ExtraArgs<Args>]
    ) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setError(null);
      setProgress(0);
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
        abort.signal.throwIfAborted();
        await uploadToAzure(ticket.uploadUrl, file, {
          headers: ticket.headers,
          onProgress: (fraction) => {
            if (controller.current === abort) setProgress(fraction);
          },
          signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        const result = await confirmUpload({ fileId: ticket.fileId });
        abort.signal.throwIfAborted();
        if (!result.ok) throw new UploadError(result.reason);
        return ticket.fileId;
      } catch (caught) {
        const failure =
          caught instanceof Error ? caught : new Error(String(caught));
        if (controller.current === abort) setError(failure);
        throw failure;
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          setProgress(null);
        }
      }
    },
    [generateUploadUrl, confirmUpload],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);

  return { upload, cancel, progress, isUploading: progress !== null, error };
}
