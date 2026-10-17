import {
  actionGeneric,
  createFunctionHandle,
  mutationGeneric,
} from "convex/server";
import type {
  Auth,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { fileFields } from "../component/schema.js";
import { resolveConfig } from "./config.js";
import type { AzureBlobConfig } from "./config.js";
import { attachmentDisposition, signBlobSas } from "./sas.js";
import type { SasResponseHeaders } from "./sas.js";
import { SNIFF_BYTES, sniffContentType } from "./sniff.js";

export { resolveConfig } from "./config.js";
export type { AzureBlobConfig } from "./config.js";
export {
  attachmentDisposition,
  blobStringToSign,
  signBlobSas,
  SAS_VERSION,
} from "./sas.js";
export type { BlobSasInput, SasResponseHeaders } from "./sas.js";
export { SNIFFABLE_CONTENT_TYPES, sniffContentType } from "./sniff.js";
export type { ComponentApi };

// The narrowest contexts each method needs; query, mutation and action contexts all fit them.
type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
type RunMutationCtx = Pick<GenericActionCtx<GenericDataModel>, "runMutation">;
type RunActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;

/** A file as the component stores it. `fileId` is what the app keeps on its own documents. */
export type FileDoc = { fileId: string } & ObjectType<typeof fileFields>;
export type FileStatus = FileDoc["status"];

/** An app mutation invoked atomically with the file's ready transition. */
export type UploadCallback = FunctionReference<
  "mutation",
  "internal",
  { fileId: string }
>;

/** Image types allowed by default, mapped to the extension of the generated blob name. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export type AzureBlobOptions = {
  /** Overrides the `AZURE_BLOB_*` environment variables. */
  config?: Partial<AzureBlobConfig>;
  /** Content type to blob-name extension. Defaults to {@link IMAGE_CONTENT_TYPES}. */
  allowedContentTypes?: Readonly<Record<string, string>>;
  /** Upper bound for every file in bytes; callers can ask for less. Default 10 MiB. */
  maxBytes?: number;
  /** Virtual folder for new blobs, e.g. `"avatars"` gives `avatars/<uuid>.png`. */
  pathPrefix?: string;
  /** How long an upload URL stays valid. Default 300. */
  uploadTtlSeconds?: number;
  /** Read URLs are signed per window so every caller in it gets the same cacheable URL. Default 3600. */
  readWindowSeconds?: number;
  /**
   * Check the first bytes of an upload against its declared type at confirm, for the types in
   * {@link SNIFFABLE_CONTENT_TYPES}. Default true.
   */
  verifyContent?: boolean;
  /** Sign every SAS with `spr=https`. Defaults to true when the endpoint is `https://`. */
  httpsOnly?: boolean;
  /** Clock for tests. */
  now?: () => number;
};

/** What the browser needs to upload: PUT the bytes to `uploadUrl` with `headers`. */
export type UploadTicket = {
  fileId: string;
  uploadUrl: string;
  headers: Record<string, string>;
};

export type ConfirmResult =
  | { ok: true; size: number; contentType: string }
  | { ok: false; reason: string };

export type StoreResult =
  { ok: true; fileId: string } | { ok: false; reason: string };

export type UrlOptions = {
  /** `true` downloads under the stored file name; a string downloads under that name. */
  download?: boolean | string;
  /** Overrides `Cache-Control` for this URL, e.g. `"public, max-age=31536000, immutable"`. */
  cacheControl?: string;
};

export const confirmResultValidator = v.union(
  v.object({ ok: v.literal(true), size: v.number(), contentType: v.string() }),
  v.object({ ok: v.literal(false), reason: v.string() }),
);

export const uploadTicketValidator = v.object({
  fileId: v.string(),
  uploadUrl: v.string(),
  headers: v.record(v.string(), v.string()),
});

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PENDING_TTL_MS = 60 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_SECONDS = 5 * 60;
const DEFAULT_READ_WINDOW_SECONDS = 60 * 60;
// Start times are backdated so a client whose clock runs slow is not refused.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SERVER_SAS_TTL_MS = 60 * 1000;
const PATH_PREFIX = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;

const mediaType = (header: string | null | undefined) =>
  (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

// Each path segment is encoded, so `/` keeps separating virtual folders.
const encodeBlobPath = (blobName: string) =>
  blobName.split("/").map(encodeURIComponent).join("/");

/**
 * Azure Blob Storage for a Convex app. Create one per container (or prefix) and call its methods
 * from your own queries, mutations and actions, after your own permission checks.
 *
 * @example
 * ```ts
 * export const azure = new AzureBlob(components.azureBlob, { maxBytes: 5 * 1024 * 1024 });
 * ```
 */
export class AzureBlob {
  constructor(
    public component: ComponentApi,
    private options: AzureBlobOptions = {},
  ) {
    if (
      options.pathPrefix !== undefined &&
      !PATH_PREFIX.test(options.pathPrefix)
    ) {
      throw new Error(
        `Invalid pathPrefix "${options.pathPrefix}": use letters, digits, "-", "_" and "/" separators`,
      );
    }
  }

  private config() {
    return resolveConfig(this.options.config, process.env);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private get allowed() {
    return this.options.allowedContentTypes ?? IMAGE_CONTENT_TYPES;
  }

  private get ceiling() {
    return this.options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private protocolFor(base: string) {
    const httpsOnly = this.options.httpsOnly ?? base.startsWith("https:");
    return httpsOnly ? ("https" as const) : undefined;
  }

  private blobUrl(base: string, container: string, blobName: string) {
    return `${base}/${container}/${encodeBlobPath(blobName)}`;
  }

  /** A short-lived URL for Convex's own request to a blob, through the internal endpoint if set. */
  private async serverUrl(
    config: AzureBlobConfig,
    container: string,
    blobName: string,
    permissions: string,
    expiresOn?: number,
  ) {
    const base = config.internalEndpoint ?? config.endpoint;
    const now = this.now();
    const sas = await signBlobSas({
      accountName: config.accountName,
      accountKey: config.accountKey,
      container,
      blobName,
      permissions,
      startsOn: now - CLOCK_SKEW_MS,
      expiresOn: expiresOn ?? now + SERVER_SAS_TTL_MS,
      protocol: this.protocolFor(base),
    });
    return `${this.blobUrl(base, container, blobName)}?${sas}`;
  }

  private async reserve(
    ctx: RunMutationCtx,
    config: AzureBlobConfig,
    args: {
      contentType: string;
      uploadedBy: string;
      maxBytes?: number;
      size?: number;
      fileName?: string;
      metadata?: Record<string, string>;
    },
    ttlMs = this.uploadTtlMs,
  ) {
    const contentType = mediaType(args.contentType);
    const extension = this.allowed[contentType];
    if (!extension) throw new ConvexError("This file type is not allowed");
    const maxBytes = Math.min(args.maxBytes ?? this.ceiling, this.ceiling);
    if (args.size !== undefined && args.size > maxBytes) {
      throw new ConvexError("The file is too large");
    }
    const prefix = this.options.pathPrefix ? `${this.options.pathPrefix}/` : "";
    const blobName = `${prefix}${crypto.randomUUID()}.${extension}`;
    const createdAt = this.now();
    const uploadExpiresAt = createdAt + ttlMs;
    const fileId = await ctx.runMutation(this.component.lib.create, {
      container: config.container,
      blobName,
      contentType,
      maxBytes,
      uploadedBy: args.uploadedBy,
      fileName: args.fileName,
      metadata: args.metadata,
      createdAt,
      uploadExpiresAt,
    });
    return { fileId, blobName, contentType, createdAt, uploadExpiresAt };
  }

  /**
   * Reserves a file and returns where the browser uploads it. The SAS can only create that one
   * blob (permission `c`), so it cannot overwrite a file after it is confirmed.
   *
   * `size` is the size the client reports; it rejects obvious oversize files early, while the
   * real size is enforced by {@link confirmUpload}.
   */
  async generateUploadUrl(
    ctx: RunMutationCtx,
    args: {
      contentType: string;
      uploadedBy: string;
      maxBytes?: number;
      size?: number;
      fileName?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<UploadTicket> {
    const config = this.config();
    const { fileId, blobName, contentType, createdAt, uploadExpiresAt } =
      await this.reserve(ctx, config, args);
    const sas = await signBlobSas({
      accountName: config.accountName,
      accountKey: config.accountKey,
      container: config.container,
      blobName,
      permissions: "c",
      startsOn: createdAt - CLOCK_SKEW_MS,
      expiresOn: uploadExpiresAt,
      protocol: this.protocolFor(config.endpoint),
    });
    return {
      fileId,
      uploadUrl: `${this.blobUrl(config.endpoint, config.container, blobName)}?${sas}`,
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": contentType },
    };
  }

  /** The file's row, or null. Includes `uploadedBy`, so the app can check ownership. */
  async getFile(ctx: RunQueryCtx, fileId: string): Promise<FileDoc | null> {
    return await ctx.runQuery(this.component.lib.get, { fileId });
  }

  /** Ready files, newest first, optionally only one uploader's. */
  async list(
    ctx: RunQueryCtx,
    args: { uploadedBy?: string; paginationOpts: PaginationOptions },
  ): Promise<PaginationResult<FileDoc>> {
    return await ctx.runQuery(this.component.lib.list, args);
  }

  /** Replaces the file's display name and/or metadata; false if the file is unknown or deleting. */
  async updateFile(
    ctx: RunMutationCtx,
    fileId: string,
    args: { fileName?: string; metadata?: Record<string, string> },
  ) {
    return await ctx.runMutation(this.component.lib.update, {
      fileId,
      ...args,
    });
  }

  /** A browser URL for a ready file, or null. See {@link urlForFile}. */
  async getUrl(ctx: RunQueryCtx, fileId: string, options: UrlOptions = {}) {
    const file = await this.getFile(ctx, fileId);
    return file ? await this.urlForFile(file, options) : null;
  }

  /**
   * A browser URL for a file you already loaded (from {@link list}, say), or null unless it is
   * ready. Read SAS URLs are signed per `readWindowSeconds` window and stay valid for two windows,
   * so query results stay cacheable. With `AZURE_BLOB_PUBLIC_BASE_URL` set, plain URLs are
   * returned instead, except for downloads, which need a signed `Content-Disposition`.
   */
  async urlForFile(
    file: Pick<FileDoc, "status" | "container" | "blobName" | "fileName">,
    options: UrlOptions = {},
  ) {
    if (file.status !== "ready") return null;
    const config = this.config();
    const responseHeaders: SasResponseHeaders = {};
    if (options.download) {
      const name =
        typeof options.download === "string"
          ? options.download
          : (file.fileName ?? file.blobName.split("/").pop() ?? file.blobName);
      responseHeaders.contentDisposition = attachmentDisposition(name);
    }
    if (options.cacheControl)
      responseHeaders.cacheControl = options.cacheControl;
    const overridden = Object.keys(responseHeaders).length > 0;
    if (config.publicBaseUrl && !overridden) {
      return `${config.publicBaseUrl}/${encodeBlobPath(file.blobName)}`;
    }
    const windowMs =
      (this.options.readWindowSeconds ?? DEFAULT_READ_WINDOW_SECONDS) * 1000;
    const windowStart = Math.floor(this.now() / windowMs) * windowMs;
    const sas = await signBlobSas({
      accountName: config.accountName,
      accountKey: config.accountKey,
      container: file.container,
      blobName: file.blobName,
      permissions: "r",
      startsOn: windowStart - CLOCK_SKEW_MS,
      expiresOn: windowStart + 2 * windowMs,
      protocol: this.protocolFor(config.endpoint),
      responseHeaders: overridden ? responseHeaders : undefined,
    });
    return `${this.blobUrl(config.endpoint, file.container, file.blobName)}?${sas}`;
  }

  /**
   * Checks the uploaded blob's size, type and (by default) leading bytes against what was
   * reserved. A blob that fails is deleted and its file removed. Confirming twice is harmless.
   * An optional app mutation attaches the file atomically; a failure rolls back confirmation.
   */
  async confirmUpload(
    ctx: RunActionCtx,
    fileId: string,
    onUpload?: UploadCallback,
  ): Promise<ConfirmResult> {
    const file = await this.getFile(ctx, fileId);
    if (!file || file.status === "deleting")
      return { ok: false, reason: "Unknown upload" };
    if (file.status === "ready") {
      return { ok: true, size: file.size ?? 0, contentType: file.contentType };
    }
    const config = this.config();
    const url = await this.serverUrl(
      config,
      file.container,
      file.blobName,
      "r",
    );
    const head = await fetch(url, { method: "HEAD" });
    if (head.status === 404) return { ok: false, reason: "Upload not found" };
    if (!head.ok) throw new Error(`Azure Blob HEAD failed with ${head.status}`);
    const size = Number(head.headers.get("content-length"));
    const contentType = mediaType(head.headers.get("content-type"));
    const reason =
      this.rejection(file, size, contentType) ??
      (await this.contentRejection(url, file));
    if (reason) {
      await this.purge(ctx, fileId);
      return { ok: false, reason };
    }
    const ready = await ctx.runMutation(this.component.lib.markReady, {
      fileId,
      size,
      onUpload: onUpload ? await createFunctionHandle(onUpload) : undefined,
    });
    return ready
      ? { ok: true, size: ready.size ?? size, contentType: ready.contentType }
      : { ok: false, reason: "Unknown upload" };
  }

  private rejection(file: FileDoc, size: number, contentType: string) {
    if (!Number.isFinite(size) || size <= 0) return "The file is empty";
    if (size > file.maxBytes) return "The file is too large";
    if (!this.allowed[contentType] || contentType !== file.contentType) {
      return "This file type is not allowed";
    }
    return null;
  }

  private async contentRejection(url: string, file: FileDoc) {
    if (this.options.verifyContent === false) return null;
    if (sniffContentType(file.contentType, new Uint8Array()) === undefined)
      return null;
    const response = await fetch(url, {
      headers: { range: `bytes=0-${SNIFF_BYTES - 1}` },
    });
    if (!response.ok)
      throw new Error(`Azure Blob GET failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()).subarray(
      0,
      SNIFF_BYTES,
    );
    return sniffContentType(file.contentType, bytes)
      ? null
      : "The file content does not match its type";
  }

  /**
   * Stops serving the file immediately; the blob goes with {@link purge} or {@link sweep}.
   * Safe inside a mutation that also changes app data. False if the file is unknown.
   */
  async markForDeletion(ctx: RunMutationCtx, fileId: string) {
    return (
      (await ctx.runMutation(this.component.lib.markDeleting, { fileId })) !==
      null
    );
  }

  /**
   * Deletes the file's blob and row. A missing blob counts as deleted; a failed delete leaves the
   * row `deleting` for {@link sweep} to retry. False if the file is unknown or the delete failed.
   * Within the upload URL's lifetime the row is kept (as `deleting`) until a later sweep.
   */
  async purge(ctx: RunActionCtx, fileId: string) {
    const marked = await ctx.runMutation(this.component.lib.markDeleting, {
      fileId,
    });
    if (!marked) return false;
    return await this.removeBlobAndRow(ctx, { fileId, ...marked });
  }

  /** Alias of {@link purge}. */
  async delete(ctx: RunActionCtx, fileId: string) {
    return await this.purge(ctx, fileId);
  }

  private get uploadTtlMs() {
    return (this.options.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS) * 1000;
  }

  /**
   * Deletes the blob, then the row. While the file's upload URL is still valid the row stays
   * `deleting`, because that URL could create the blob again; `sweep` finishes the job later.
   */
  private async removeBlobAndRow(
    ctx: RunActionCtx,
    file: {
      fileId: string;
      container: string;
      blobName: string;
      createdAt: number;
      uploadExpiresAt: number;
    },
  ) {
    const url = await this.serverUrl(
      this.config(),
      file.container,
      file.blobName,
      "d",
    );
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) return false;
    if (this.now() >= file.uploadExpiresAt + CLOCK_SKEW_MS) {
      await ctx.runMutation(this.component.lib.remove, { fileId: file.fileId });
    }
    return true;
  }

  /**
   * Deletes the blobs and rows of files marked for deletion and of uploads never confirmed
   * (pending longer than `pendingOlderThanMs`, default one hour). Returns how many blobs it
   * deleted (or found already gone).
   * Run it from a cron.
   */
  async sweep(
    ctx: RunActionCtx,
    args: { pendingOlderThanMs?: number; limit?: number } = {},
  ) {
    const stale = await ctx.runMutation(this.component.lib.claimSweepable, {
      pendingBefore:
        this.now() - (args.pendingOlderThanMs ?? DEFAULT_PENDING_TTL_MS),
      limit: args.limit ?? 100,
    });
    let removed = 0;
    for (const file of stale) {
      if (await this.removeBlobAndRow(ctx, file)) removed += 1;
    }
    return removed;
  }

  /** Uploads bytes from an action (imports, migrations, generated files): reserve, PUT, confirm. */
  async store(
    ctx: RunActionCtx,
    args: {
      data: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
      contentType: string;
      uploadedBy: string;
      maxBytes?: number;
      fileName?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<StoreResult> {
    const config = this.config();
    const { data, ...rest } = args;
    const body = data instanceof Blob ? data : new Blob([data]);
    const { fileId, blobName, contentType, uploadExpiresAt } =
      await this.reserve(
        ctx,
        config,
        { ...rest, size: body.size },
        SERVER_SAS_TTL_MS,
      );
    const url = await this.serverUrl(
      config,
      config.container,
      blobName,
      "c",
      uploadExpiresAt,
    );
    const response = await fetch(url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": contentType },
      body,
    });
    if (!response.ok) {
      await this.purge(ctx, fileId);
      return {
        ok: false,
        reason: `Azure Blob upload failed with ${response.status}`,
      };
    }
    const confirmed = await this.confirmUpload(ctx, fileId);
    return confirmed.ok ? { ok: true, fileId } : confirmed;
  }

  /**
   * Ready-made public functions for the upload flow, for use with `useUploadFile` from
   * `convex-azure-blob/react`. Export them from one of your modules:
   *
   * ```ts
   * export const { generateUploadUrl, confirmUpload } = azure.clientApi({
   *   identify: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null,
   * });
   * ```
   */
  clientApi<DataModel extends GenericDataModel>(
    options: ClientApiOptions<DataModel>,
  ) {
    const identify = async (ctx: { auth: Auth }) => {
      const uploadedBy = await options.identify(ctx);
      if (!uploadedBy) throw new ConvexError("Not authorized to upload files");
      return uploadedBy;
    };
    return {
      generateUploadUrl: mutationGeneric({
        args: {
          contentType: v.string(),
          fileName: v.optional(v.string()),
          size: v.optional(v.number()),
        },
        returns: uploadTicketValidator,
        handler: async (ctx, args): Promise<UploadTicket> => {
          const uploadedBy = await identify(ctx);
          await options.checkUpload?.(ctx as GenericMutationCtx<DataModel>, {
            ...args,
            uploadedBy,
          });
          return await this.generateUploadUrl(ctx, { ...args, uploadedBy });
        },
      }),
      confirmUpload: actionGeneric({
        args: { fileId: v.string() },
        returns: confirmResultValidator,
        handler: async (ctx, args): Promise<ConfirmResult> => {
          const uploadedBy = await identify(ctx);
          const file = await this.getFile(ctx, args.fileId);
          // Someone else's upload looks the same as one that does not exist.
          if (!file || file.uploadedBy !== uploadedBy) {
            return { ok: false, reason: "Unknown upload" };
          }
          return await this.confirmUpload(ctx, args.fileId, options.onUpload);
        },
      }),
    };
  }
}

export type ClientApiOptions<DataModel extends GenericDataModel> = {
  /**
   * The uploader id for the caller (usually the user id), or null to refuse. It runs in both the
   * mutation and the action, and only the uploader can confirm their upload.
   */
  identify: (ctx: { auth: Auth }) => Promise<string | null>;
  /** Extra checks before an upload URL is issued (quota, role). Throw to refuse. */
  checkUpload?: (
    ctx: GenericMutationCtx<DataModel>,
    args: {
      uploadedBy: string;
      contentType: string;
      fileName?: string;
      size?: number;
    },
  ) => void | Promise<void>;
  /**
   * An internal mutation accepting `{ fileId }`, committed with the ready transition.
   * Throws roll back both attachment and confirmation. Schedule external work from the mutation.
   */
  onUpload?: UploadCallback;
};
