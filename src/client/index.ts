import {
  actionGeneric,
  createFunctionHandle,
  httpActionGeneric,
  internalActionGeneric,
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
import { getAccessToken, requestUserDelegationKey } from "./auth.js";
import { resolveConfig } from "./config.js";
import type { AzureBlobConfig } from "./config.js";
import { effectiveUploadExpiry } from "./upload-expiry.js";
import { blockId, blockSizeFor, MAX_BLOCKS, parseBlockList } from "./blocks.js";
import {
  attachmentDisposition,
  SAS_VERSION,
  signBlobSas,
  signUserDelegationSas,
} from "./sas.js";
import type { SasResponseHeaders } from "./sas.js";
import type { UserDelegationKey } from "./sas.js";
import { SNIFF_BYTES, sniffContentType } from "./sniff.js";

export { resolveConfig } from "./config.js";
export type { AzureBlobConfig } from "./config.js";
export {
  attachmentDisposition,
  blobStringToSign,
  signBlobSas,
  signUserDelegationSas,
  userDelegationStringToSign,
  SAS_VERSION,
} from "./sas.js";
export type {
  BlobSasInput,
  SasResponseHeaders,
  UserDelegationKey,
  UserDelegationSasInput,
} from "./sas.js";
export { SNIFFABLE_CONTENT_TYPES, sniffContentType } from "./sniff.js";
export type { ComponentApi };

// The narrowest contexts each method needs; query, mutation and action contexts all fit them.
type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
type RunMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
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
  /** Stage sliced blocks and confirm an immutable snapshot. Default false. */
  blockUploads?: boolean;
  /** Keep confirmed files unservable until Defender for Storage reports a clean scan. */
  requireMalwareScan?: boolean;
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

export type EventGridHandlerOptions = {
  /** Shared secret of at least 32 characters, supplied in the Event Grid endpoint query string. */
  secret: string;
  /** An internal mutation invoked atomically when the upload becomes ready. */
  onUpload?: UploadCallback;
};

/** What the browser needs to upload: PUT the bytes to `uploadUrl` with `headers`. */
export type UploadTicket = {
  fileId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  kind?: "blocks";
  blockSize?: number;
  expiresAt?: number;
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
  kind: v.optional(v.literal("blocks")),
  blockSize: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
});

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PENDING_TTL_MS = 60 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_SECONDS = 5 * 60;
const DEFAULT_READ_WINDOW_SECONDS = 60 * 60;
const DEFAULT_MALWARE_SCAN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MALWARE_SCAN_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
const MAX_MALWARE_SCAN_BATCH = 50;
// Start times are backdated so a client whose clock runs slow is not refused.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SERVER_SAS_TTL_MS = 60 * 1000;
const DELEGATION_KEY_REFRESH_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;
const PATH_PREFIX = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;
const isTransientAzureStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

const mediaType = (header: string | null | undefined) =>
  (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

// Canonical base64 of exactly 16 bytes: 22 chars plus "==" padding, with zero trailing bits.
const isMd5Base64 = (value: string) =>
  /^[A-Za-z0-9+/]{21}[AQgw]==$/.test(value);

function decodeXmlText(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function malwareScanResult(xml: string) {
  for (const match of xml.matchAll(
    /<Tag>\s*<Key>([\s\S]*?)<\/Key>\s*<Value>([\s\S]*?)<\/Value>\s*<\/Tag>/gi,
  )) {
    const key = decodeXmlText(match[1]!).trim().toLowerCase();
    if (key === "scan result" || key === "malware scanning scan result") {
      return decodeXmlText(match[2]!).trim().toLowerCase();
    }
  }
  return undefined;
}

type EventGridEvent = {
  eventType: string;
  data: Record<string, unknown>;
  validationCode?: string;
  blobUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventGridEvents(value: unknown): EventGridEvent[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const events: EventGridEvent[] = [];
  for (const event of value) {
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      event.id.length === 0 ||
      typeof event.eventType !== "string" ||
      event.eventType.length === 0 ||
      typeof event.subject !== "string" ||
      typeof event.eventTime !== "string" ||
      !Number.isFinite(Date.parse(event.eventTime)) ||
      typeof event.dataVersion !== "string" ||
      typeof event.metadataVersion !== "string" ||
      (event.topic !== undefined && typeof event.topic !== "string") ||
      !isRecord(event.data)
    )
      return null;
    let validationCode: string | undefined;
    let blobUrl: string | undefined;
    if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      if (
        typeof event.data.validationCode !== "string" ||
        event.data.validationCode.length === 0
      )
        return null;
      validationCode = event.data.validationCode;
    }
    if (event.eventType === "Microsoft.Storage.BlobCreated") {
      if (typeof event.data.url !== "string") return null;
      try {
        const url = new URL(event.data.url);
        if (url.protocol !== "https:") return null;
        url.pathname
          .split("/")
          .filter(Boolean)
          .forEach((segment) => decodeURIComponent(segment));
      } catch {
        return null;
      }
      blobUrl = event.data.url;
    }
    events.push({
      eventType: event.eventType,
      data: event.data,
      ...(validationCode !== undefined ? { validationCode } : {}),
      ...(blobUrl !== undefined ? { blobUrl } : {}),
    });
  }
  return events;
}

function blobAddressFromEventUrl(
  eventUrl: string,
  endpoint: string,
): { container: string; blobName: string } | null {
  const segments = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  const endpointSegments = segments(new URL(endpoint).pathname);
  const eventSegments = segments(new URL(eventUrl).pathname);
  if (
    endpointSegments.some((segment, index) => eventSegments[index] !== segment)
  )
    return null;
  const [container, ...blobSegments] = eventSegments.slice(
    endpointSegments.length,
  );
  if (!container || blobSegments.length === 0) return null;
  return { container, blobName: blobSegments.join("/") };
}

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
    if (options.blockUploads && options.requireMalwareScan)
      throw new Error(
        "Malware scan gating cannot be combined with blockUploads because scan tags are not tied to the immutable snapshot",
      );
    if (
      options.blockUploads &&
      (!Number.isFinite(
        options.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS,
      ) ||
        (options.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS) <= 0 ||
        (options.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS) >
          7 * 24 * 60 * 60)
    )
      throw new Error("Block upload TTL must be between 0 and 604800 seconds");
    if (
      options.pathPrefix !== undefined &&
      !PATH_PREFIX.test(options.pathPrefix)
    ) {
      throw new Error(
        `Invalid pathPrefix "${options.pathPrefix}": use letters, digits, "-", "_" and "/" separators`,
      );
    }
  }

  /**
   * Creates an HTTP action for standard-schema Event Grid BlobCreated events.
   * Use a cryptographically random secret of at least 32 characters.
   *
   * @example
   * ```ts
   * const handler = azure.eventGridHandler({
   *   secret: process.env.AZURE_BLOB_EVENT_GRID_SECRET ?? "",
   *   onUpload: internal.files.attach,
   * });
   * ```
   */
  eventGridHandler(options: EventGridHandlerOptions) {
    if (options.secret.length < 32) {
      throw new Error("Event Grid secret must be at least 32 characters");
    }
    return httpActionGeneric(async (ctx, request) => {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      const requestUrl = new URL(request.url);
      if (requestUrl.protocol !== "https:")
        return new Response("HTTPS is required", { status: 400 });
      if (requestUrl.searchParams.get("secret") !== options.secret)
        return new Response("Unauthorized", { status: 401 });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid Event Grid request body", { status: 400 });
      }
      const events = parseEventGridEvents(body);
      if (!events) {
        return new Response("Invalid Event Grid event schema", { status: 400 });
      }
      const validations = events.filter(
        (event) =>
          event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent",
      );
      if (validations.length > 0) {
        if (events.length !== 1) {
          return new Response("Invalid subscription validation batch", {
            status: 400,
          });
        }
        const validationCode = validations[0]!.validationCode;
        if (!validationCode)
          return new Response("Invalid subscription validation event", {
            status: 400,
          });
        return new Response(
          JSON.stringify({
            validationResponse: validationCode,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      let config: AzureBlobConfig | undefined;
      for (const event of events) {
        if (event.eventType !== "Microsoft.Storage.BlobCreated") continue;
        const blobUrl = event.blobUrl;
        if (!blobUrl) continue;
        config ??= this.config();
        const address = blobAddressFromEventUrl(blobUrl, config.endpoint);
        if (!address || address.container !== config.container) continue;
        const prefix = this.options.pathPrefix;
        if (prefix && !address.blobName.startsWith(`${prefix}/`)) continue;
        try {
          const file = await ctx.runQuery(this.component.lib.getByBlobName, {
            ...address,
          });
          if (!file) continue;
          await this.confirmUpload(ctx, file.fileId, options.onUpload);
        } catch {
          console.error(
            "Event Grid upload confirmation failed; returning 503 for retry",
          );
          return new Response("Upload confirmation failed; retry delivery", {
            status: 503,
          });
        }
      }
      return new Response(null, { status: 200 });
    });
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
    snapshot?: string,
  ) {
    if (!config.accountKey) {
      throw new Error("Account-key signing requires AZURE_BLOB_KEY");
    }
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
      snapshot,
    });
    return `${this.blobUrl(base, container, blobName)}?${sas}`;
  }

  private async serverRequest(
    config: AzureBlobConfig,
    container: string,
    blobName: string,
    permissions: string,
    expiresOn?: number,
    accessToken?: string,
    params: Record<string, string> = {},
  ) {
    if (config.accountKey) {
      const url = new URL(
        await this.serverUrl(
          config,
          container,
          blobName,
          permissions,
          expiresOn,
          params.snapshot,
        ),
      );
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
      return { url: url.toString() };
    }
    const token = accessToken ?? (await getAccessToken(config));
    const base = config.internalEndpoint ?? config.endpoint;
    const url = new URL(this.blobUrl(base, container, blobName));
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return {
      url: url.toString(),
      headers: {
        authorization: `Bearer ${token}`,
        "x-ms-version": SAS_VERSION,
      },
    };
  }

  private async cachedUserDelegationKey(
    ctx: RunQueryCtx,
    config: AzureBlobConfig,
  ): Promise<UserDelegationKey> {
    const key = await ctx.runQuery(this.component.lib.getUserDelegationKey, {
      accountName: config.accountName,
      now: this.now(),
    });
    if (!key) {
      throw new Error(
        "No valid Azure user delegation key is cached; run AzureBlob.refreshUserDelegationKey from an action or cron",
      );
    }
    return key;
  }

  /**
   * Refreshes the cached delegation key when it expires within two days. Pass `{ force: true }`
   * to replace a still-valid key, e.g. after revoking it in Azure.
   */
  async refreshUserDelegationKey(
    ctx: RunActionCtx,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const config = this.config();
    if (config.accountKey) return;
    const now = this.now();
    const cached = options.force
      ? null
      : await ctx.runQuery(this.component.lib.getUserDelegationKey, {
          accountName: config.accountName,
          now,
        });
    if (
      cached &&
      Date.parse(cached.signedExpiry) - now >
        DELEGATION_KEY_REFRESH_THRESHOLD_MS
    ) {
      return;
    }
    const key = await requestUserDelegationKey(config, now);
    if (Date.parse(key.signedExpiry) <= now) {
      throw new Error("Azure Blob returned an expired user delegation key");
    }
    await ctx.runMutation(this.component.lib.upsertUserDelegationKey, {
      accountName: config.accountName,
      ...key,
    });
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
      md5?: string;
    },
    ttlMs = this.uploadTtlMs,
    blocks = false,
  ) {
    const contentType = mediaType(args.contentType);
    const extension = this.allowed[contentType];
    if (!extension) throw new ConvexError("This file type is not allowed");
    const maxBytes = Math.min(args.maxBytes ?? this.ceiling, this.ceiling);
    let blockSize: number | undefined;
    if (blocks) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw new ConvexError("Invalid block upload size");
      try {
        blockSize = blockSizeFor(args.size!);
      } catch {
        throw new ConvexError("Invalid block upload size");
      }
    }
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
      ...(this.options.requireMalwareScan ? { malwareScanRequired: true } : {}),
      ...(args.md5 ? { md5: args.md5 } : {}),
      createdAt,
      uploadExpiresAt,
      ...(blocks
        ? { uploadMode: "blocks" as const, expectedSize: args.size, blockSize }
        : {}),
    });
    return {
      fileId,
      blobName,
      contentType,
      createdAt,
      uploadExpiresAt,
      md5: args.md5,
    };
  }

  /**
   * Reserves a file and returns a create-only PUT ticket, or a write-only block staging ticket
   * when `blockUploads` is enabled. Block uploads are confirmed as immutable snapshots.
   *
   * `size` is the size the client reports; it rejects obvious oversize files early, while the
   * real size is enforced by {@link confirmUpload}.
   *
   * `md5` is the file's MD5 as base64 (16 bytes); the app must compute it, since Web Crypto has
   * no MD5. The ticket then carries `Content-MD5`, so Azure refuses a body that differs, and
   * {@link confirmUpload} rejects a blob whose stored checksum differs. Not supported with
   * `blockUploads`.
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
      md5?: string;
    },
  ): Promise<UploadTicket> {
    if (args.md5 !== undefined) {
      if (this.options.blockUploads)
        throw new ConvexError("md5 is not supported with block uploads");
      if (!isMd5Base64(args.md5))
        throw new ConvexError("md5 must be a base64-encoded 16-byte digest");
    }
    const config = this.config();
    const delegationKey = config.accountKey
      ? undefined
      : await this.cachedUserDelegationKey(ctx, config);
    const ttl = delegationKey
      ? Math.min(
          this.uploadTtlMs,
          Date.parse(delegationKey.signedExpiry) - this.now(),
        )
      : this.uploadTtlMs;
    const reserved = await this.reserve(
      ctx,
      config,
      args,
      ttl,
      this.options.blockUploads === true,
    );
    return await this.uploadTicket(
      ctx,
      config,
      {
        ...reserved,
        ...(this.options.blockUploads
          ? { uploadMode: "blocks", blockSize: blockSizeFor(args.size!) }
          : {}),
      },
      delegationKey,
    );
  }

  private async uploadTicket(
    ctx: RunQueryCtx,
    config: AzureBlobConfig,
    file: {
      fileId: string;
      blobName: string;
      contentType: string;
      createdAt: number;
      uploadExpiresAt: number;
      uploadMode?: string;
      blockSize?: number;
      md5?: string;
    },
    delegationKey?: UserDelegationKey,
  ): Promise<UploadTicket> {
    const { fileId, blobName, contentType, createdAt, uploadExpiresAt } = file;
    const startsOn = createdAt - CLOCK_SKEW_MS;
    const protocol = this.protocolFor(config.endpoint);
    const sas = config.accountKey
      ? await signBlobSas({
          accountName: config.accountName,
          accountKey: config.accountKey,
          container: config.container,
          blobName,
          permissions: file.uploadMode === "blocks" ? "w" : "c",
          startsOn,
          expiresOn: uploadExpiresAt,
          protocol,
        })
      : await this.signDelegationSas(
          ctx,
          config,
          {
            container: config.container,
            blobName,
            permissions: file.uploadMode === "blocks" ? "w" : "c",
            startsOn,
            expiresOn: uploadExpiresAt,
            protocol,
          },
          delegationKey,
        );
    return {
      fileId,
      uploadUrl: `${this.blobUrl(config.endpoint, config.container, blobName)}?${sas}`,
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "content-type": contentType,
        ...(file.md5 ? { "Content-MD5": file.md5 } : {}),
      },
      ...(file.uploadMode === "blocks"
        ? {
            kind: "blocks" as const,
            blockSize: file.blockSize,
            expiresAt: uploadExpiresAt,
          }
        : {}),
    };
  }

  /** Renews the same owner's pending upload without changing its blob name. */
  async renewUploadUrl(
    ctx: RunMutationCtx,
    args: { fileId: string; uploadedBy: string },
  ): Promise<UploadTicket> {
    const current = await this.getFile(ctx, args.fileId);
    if (
      !current ||
      current.uploadedBy !== args.uploadedBy ||
      current.status !== "pending"
    )
      throw new ConvexError("Unknown upload");
    const config = this.config();
    const key = config.accountKey
      ? undefined
      : await this.cachedUserDelegationKey(ctx, config);
    const now = this.now();
    const expiresAt = Math.min(
      now + this.uploadTtlMs,
      key ? Date.parse(key.signedExpiry) : Infinity,
    );
    const file = await ctx.runMutation(this.component.lib.renewUpload, {
      ...args,
      now,
      expiresAt,
    });
    if (!file) throw new ConvexError("Unknown upload");
    return await this.uploadTicket(
      ctx,
      { ...config, container: file.container },
      {
        ...file,
        createdAt: now,
        uploadExpiresAt: expiresAt,
      },
      key,
    );
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
    return file ? await this.urlForFile(file, options, ctx) : null;
  }

  /**
   * A browser URL for a file you already loaded (from {@link list}, say), or null unless it is
   * ready. Read SAS URLs are signed per `readWindowSeconds` window and stay valid for two windows,
   * so query results stay cacheable. With `AZURE_BLOB_PUBLIC_BASE_URL` set, plain URLs are
   * returned instead, except for downloads, which need a signed `Content-Disposition`. Pass a
   * query context as the third argument when using Microsoft Entra credentials.
   */
  async urlForFile(
    file: Pick<
      FileDoc,
      | "status"
      | "container"
      | "blobName"
      | "fileName"
      | "snapshot"
      | "uploadMode"
    >,
    options: UrlOptions = {},
    ctx?: RunQueryCtx,
  ) {
    if (file.status !== "ready") return null;
    if (file.uploadMode === "blocks" && !file.snapshot) return null;
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
    if (config.publicBaseUrl && !overridden && !file.snapshot) {
      return `${config.publicBaseUrl}/${encodeBlobPath(file.blobName)}`;
    }
    const windowMs =
      (this.options.readWindowSeconds ?? DEFAULT_READ_WINDOW_SECONDS) * 1000;
    const windowStart = Math.floor(this.now() / windowMs) * windowMs;
    const startsOn = windowStart - CLOCK_SKEW_MS;
    const expiresOn = windowStart + 2 * windowMs;
    const protocol = this.protocolFor(config.endpoint);
    let sas: string;
    if (config.accountKey) {
      sas = await signBlobSas({
        accountName: config.accountName,
        accountKey: config.accountKey,
        container: file.container,
        blobName: file.blobName,
        permissions: "r",
        startsOn,
        expiresOn,
        protocol,
        responseHeaders: overridden ? responseHeaders : undefined,
        snapshot: file.snapshot,
      });
    } else {
      if (!ctx) {
        throw new Error(
          "urlForFile requires a query context when using Microsoft Entra credentials",
        );
      }
      sas = await this.signDelegationSas(ctx, config, {
        container: file.container,
        blobName: file.blobName,
        permissions: "r",
        startsOn,
        expiresOn,
        protocol,
        responseHeaders: overridden ? responseHeaders : undefined,
        snapshot: file.snapshot,
      });
    }
    return `${this.blobUrl(config.endpoint, file.container, file.blobName)}?${sas}`;
  }

  private async signDelegationSas(
    ctx: RunQueryCtx,
    config: AzureBlobConfig,
    input: {
      container: string;
      blobName: string;
      permissions: string;
      startsOn: number;
      expiresOn: number;
      protocol?: "https";
      responseHeaders?: SasResponseHeaders;
      snapshot?: string;
    },
    cachedKey?: UserDelegationKey,
  ) {
    const key = cachedKey ?? (await this.cachedUserDelegationKey(ctx, config));
    const keyStart = Date.parse(key.signedStart);
    const keyExpiry = Date.parse(key.signedExpiry);
    return await signUserDelegationSas({
      accountName: config.accountName,
      container: input.container,
      blobName: input.blobName,
      permissions: input.permissions,
      startsOn: Math.max(input.startsOn, keyStart),
      expiresOn: Math.min(input.expiresOn, keyExpiry),
      protocol: input.protocol,
      responseHeaders: input.responseHeaders,
      delegationKey: key,
      snapshot: input.snapshot,
    });
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
    let file = await this.getFile(ctx, fileId);
    if (!file || file.status === "deleting")
      return { ok: false, reason: "Unknown upload" };
    if (
      file.status === "ready" ||
      file.status === "scanning" ||
      file.status === "rejected" ||
      file.status === "scan_timed_out"
    ) {
      if (file.status === "rejected")
        return { ok: false, reason: "Malware scan detected a threat" };
      if (file.status === "scan_timed_out")
        return { ok: false, reason: "Malware scan timed out" };
      return { ok: true, size: file.size ?? 0, contentType: file.contentType };
    }
    const config = this.config();
    if (file.uploadMode === "blocks" && !file.snapshot) {
      if (effectiveUploadExpiry(file, this.uploadTtlMs) <= this.now())
        return { ok: false, reason: "Upload expired" };
      const snapshot = await this.commitBlocks(ctx, config, file);
      if (!snapshot.ok) return snapshot;
      file = { ...file, snapshot: snapshot.snapshot };
    }
    const request = await this.serverRequest(
      config,
      file.container,
      file.blobName,
      "r",
      undefined,
      undefined,
      file.snapshot ? { snapshot: file.snapshot } : {},
    );
    const head = await fetch(request.url, {
      method: "HEAD",
      ...(request.headers ? { headers: request.headers } : {}),
    });
    if (head.status === 404) return { ok: false, reason: "Upload not found" };
    if (!head.ok) throw new Error(`Azure Blob HEAD failed with ${head.status}`);
    const size = Number(head.headers.get("content-length"));
    const contentType = mediaType(head.headers.get("content-type"));
    const reason =
      this.rejection(file, size, contentType) ??
      (file.md5 && head.headers.get("content-md5") !== file.md5
        ? "Checksum mismatch"
        : null) ??
      (file.uploadMode === "blocks" && size !== file.expectedSize
        ? "The upload size does not match"
        : null) ??
      (await this.contentRejection(request.url, file, request.headers));
    if (reason) {
      await this.purge(ctx, fileId);
      return { ok: false, reason };
    }
    const onUploadHandle = onUpload
      ? await createFunctionHandle(onUpload)
      : undefined;
    const scanNow = this.now();
    const confirmed = file.malwareScanRequired
      ? await ctx.runMutation(this.component.lib.markScanning, {
          fileId,
          size,
          now: scanNow,
          deadlineAt: scanNow + DEFAULT_MALWARE_SCAN_TIMEOUT_MS,
          onUpload: onUploadHandle,
          ...(file.snapshot ? { snapshot: file.snapshot } : {}),
        })
      : await ctx.runMutation(this.component.lib.markReady, {
          fileId,
          size,
          onUpload: onUploadHandle,
          ...(file.snapshot ? { snapshot: file.snapshot } : {}),
        });
    return confirmed
      ? {
          ok: true,
          size: confirmed.size ?? size,
          contentType: confirmed.contentType,
        }
      : { ok: false, reason: "Unknown upload" };
  }

  /** Checks a bounded batch of due Defender scan jobs; run from the returned internal action. */
  async scanMalware(ctx: RunActionCtx, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new ConvexError("Malware scan limit must be a positive integer");
    const now = this.now();
    const jobs = await ctx.runQuery(this.component.lib.dueMalwareScans, {
      now,
      limit: Math.min(limit, MAX_MALWARE_SCAN_BATCH),
    });
    if (jobs.length === 0) return 0;
    let config: AzureBlobConfig | undefined;
    let accessToken: string | undefined;
    let checked = 0;
    const failures: unknown[] = [];
    for (const job of jobs) {
      checked += 1;
      let cleanup = job.phase === "cleanup";
      let cleanupAttempts = cleanup ? job.attempts : 0;
      try {
        if (now >= job.deadlineAt && !cleanup) {
          await ctx.runMutation(this.component.lib.markScanTimedOut, {
            fileId: job.fileId,
            now,
          });
          continue;
        }
        if (!config) config = this.config();
        if (!config.accountKey && !accessToken)
          accessToken = await getAccessToken(config);
        if (cleanup) {
          if (job.cleanupUntil === undefined)
            throw new ConvexError("Malware cleanup job has no expiry");
          await this.deleteMaliciousBlob(config, accessToken, job);
          if (now >= job.cleanupUntil) {
            await ctx.runMutation(this.component.lib.finishMalwareCleanup, {
              fileId: job.fileId,
            });
          } else {
            await this.deferMalwareScan(
              ctx,
              job.fileId,
              job.attempts,
              now,
              job.deadlineAt,
              true,
            );
          }
          continue;
        }
        const request = await this.serverRequest(
          config,
          job.container,
          job.blobName,
          "t",
          undefined,
          accessToken,
          { comp: "tags" },
        );
        const response = await fetch(request.url, {
          method: "GET",
          ...(request.headers ? { headers: request.headers } : {}),
        });
        if (response.status === 404) {
          await this.deferMalwareScan(
            ctx,
            job.fileId,
            job.attempts,
            now,
            job.deadlineAt,
          );
          continue;
        }
        if (!response.ok)
          throw new Error(`Azure Blob tag read failed with ${response.status}`);
        const result = malwareScanResult(await response.text());
        if (result === "no threats found") {
          await ctx.runMutation(this.component.lib.markReady, {
            fileId: job.fileId,
            size: job.size,
            onUpload: job.onUpload,
            ...(job.snapshot ? { snapshot: job.snapshot } : {}),
          });
        } else if (result === "malicious") {
          const cleanupUntil = (job.uploadExpiresAt ?? now) + CLOCK_SKEW_MS;
          await ctx.runMutation(this.component.lib.markScanRejected, {
            fileId: job.fileId,
            now,
            cleanupUntil,
          });
          cleanup = true;
          cleanupAttempts = 0;
          await this.deleteMaliciousBlob(config, accessToken, job);
          if (now >= cleanupUntil) {
            await ctx.runMutation(this.component.lib.finishMalwareCleanup, {
              fileId: job.fileId,
            });
          } else {
            await this.deferMalwareScan(
              ctx,
              job.fileId,
              0,
              now,
              job.deadlineAt,
              true,
            );
          }
        } else {
          await this.deferMalwareScan(
            ctx,
            job.fileId,
            job.attempts,
            now,
            job.deadlineAt,
          );
        }
      } catch (error) {
        failures.push(error);
        if (cleanup || now < job.deadlineAt) {
          try {
            await this.deferMalwareScan(
              ctx,
              job.fileId,
              cleanup ? cleanupAttempts : job.attempts,
              now,
              job.deadlineAt,
              cleanup,
            );
          } catch (deferError) {
            failures.push(deferError);
          }
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Failed to process ${failures.length} malware scan job operation(s)`,
      );
    return checked;
  }

  private async deleteMaliciousBlob(
    config: AzureBlobConfig,
    accessToken: string | undefined,
    job: { container: string; blobName: string },
  ) {
    const deletion = await this.serverRequest(
      config,
      job.container,
      job.blobName,
      "d",
      undefined,
      accessToken,
    );
    const deleted = await fetch(deletion.url, {
      method: "DELETE",
      headers: {
        ...deletion.headers,
        "x-ms-delete-snapshots": "include",
      },
    });
    if (!deleted.ok && deleted.status !== 404)
      throw new Error(
        `Azure Blob malware rejection delete failed with ${deleted.status}`,
      );
  }

  private async deferMalwareScan(
    ctx: RunActionCtx,
    fileId: string,
    attempts: number,
    now: number,
    deadlineAt: number,
    cleanup = false,
  ) {
    const delay =
      MALWARE_SCAN_BACKOFF_MS[
        Math.min(attempts, MALWARE_SCAN_BACKOFF_MS.length - 1)
      ]!;
    const nextCheckAt = cleanup
      ? now + delay
      : Math.min(now + delay, deadlineAt);
    await ctx.runMutation(this.component.lib.deferMalwareScan, {
      fileId,
      now,
      nextCheckAt,
    });
  }

  private async commitBlocks(
    ctx: RunActionCtx,
    config: AzureBlobConfig,
    file: FileDoc,
  ): Promise<{ ok: true; snapshot: string } | { ok: false; reason: string }> {
    const expectedSize = file.expectedSize;
    const blockSize = file.blockSize;
    if (
      !expectedSize ||
      !blockSize ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize > file.maxBytes
    )
      return { ok: false, reason: "Invalid block upload size" };
    const count = Math.ceil(expectedSize / blockSize);
    if (count > MAX_BLOCKS)
      return { ok: false, reason: "Invalid block upload size" };
    const read = await this.serverRequest(
      config,
      file.container,
      file.blobName,
      "r",
      undefined,
      undefined,
      { comp: "blocklist", blocklisttype: "all" },
    );
    const list = await fetch(read.url, { headers: read.headers });
    if (list.status === 404) return { ok: false, reason: "Upload not found" };
    if (!list.ok)
      throw new Error(`Azure Blob block list failed with ${list.status}`);
    let blocks: ReturnType<typeof parseBlockList>;
    const xmlResponse = await list.text();
    try {
      blocks = parseBlockList(xmlResponse);
    } catch {
      return { ok: false, reason: "Invalid block list" };
    }
    const selected = new Map<string, (typeof blocks)[number]>();
    for (const block of blocks) {
      if (!selected.has(block.id) || !block.committed)
        selected.set(block.id, block);
    }
    if (selected.size !== count)
      return { ok: false, reason: "The upload size does not match" };
    let xml = '<?xml version="1.0" encoding="utf-8"?><BlockList>';
    for (let index = 0; index < count; index++) {
      const id = blockId(index);
      const block = selected.get(id);
      if (
        !block ||
        block.size !== Math.min(blockSize, expectedSize - index * blockSize)
      )
        return { ok: false, reason: "The upload size does not match" };
      const tag = block.committed ? "Committed" : "Uncommitted";
      xml += `<${tag}>${id}</${tag}>`;
    }
    xml += "</BlockList>";
    const base = await this.serverRequest(
      config,
      file.container,
      file.blobName,
      "r",
    );
    const head = await fetch(base.url, {
      method: "HEAD",
      headers: base.headers,
    });
    if (!head.ok && head.status !== 404)
      throw new Error(`Azure Blob HEAD failed with ${head.status}`);
    const etag = head.headers.get("etag");
    if (head.ok && !etag) return { ok: false, reason: "Missing blob ETag" };
    const commit = await this.serverRequest(
      config,
      file.container,
      file.blobName,
      "w",
      undefined,
      undefined,
      { comp: "blocklist" },
    );
    const committed = await fetch(commit.url, {
      method: "PUT",
      headers: {
        ...commit.headers,
        "content-type": "application/xml",
        "x-ms-blob-content-type": file.contentType,
        ...(head.ok ? { "If-Match": etag! } : { "If-None-Match": "*" }),
      },
      body: xml,
    });
    if (!committed.ok) {
      if (isTransientAzureStatus(committed.status))
        throw new Error(`Azure Blob commit failed with ${committed.status}`);
      return {
        ok: false,
        reason: `Azure Blob commit failed with ${committed.status}`,
      };
    }
    const committedEtag = committed.headers.get("etag");
    if (!committedEtag) return { ok: false, reason: "Missing committed ETag" };
    const snapshotRequest = await this.serverRequest(
      config,
      file.container,
      file.blobName,
      "w",
      undefined,
      undefined,
      { comp: "snapshot" },
    );
    const response = await fetch(snapshotRequest.url, {
      method: "PUT",
      headers: { ...snapshotRequest.headers, "If-Match": committedEtag },
    });
    if (!response.ok) {
      if (isTransientAzureStatus(response.status))
        throw new Error(`Azure Blob snapshot failed with ${response.status}`);
      return {
        ok: false,
        reason: `Azure Blob snapshot failed with ${response.status}`,
      };
    }
    const snapshot = response.headers.get("x-ms-snapshot");
    if (!snapshot || !Number.isFinite(Date.parse(snapshot)))
      return { ok: false, reason: "Missing upload snapshot" };
    const recorded = await ctx.runMutation(this.component.lib.recordSnapshot, {
      fileId: file.fileId,
      snapshot,
    });
    return recorded
      ? { ok: true, snapshot: recorded }
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

  private async contentRejection(
    url: string,
    file: FileDoc,
    authorizationHeaders?: Record<string, string>,
  ) {
    if (this.options.verifyContent === false) return null;
    if (sniffContentType(file.contentType, new Uint8Array()) === undefined)
      return null;
    const response = await fetch(url, {
      headers: {
        ...authorizationHeaders,
        range: `bytes=0-${SNIFF_BYTES - 1}`,
      },
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
      uploadExpiresAt?: number;
    },
  ) {
    const request = await this.serverRequest(
      this.config(),
      file.container,
      file.blobName,
      "d",
    );
    const response = await fetch(request.url, {
      method: "DELETE",
      headers: { ...request.headers, "x-ms-delete-snapshots": "include" },
    });
    if (!response.ok && response.status !== 404) return false;
    if (
      this.now() >=
      effectiveUploadExpiry(file, this.uploadTtlMs) + CLOCK_SKEW_MS
    ) {
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
      now: this.now(),
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
    const accessToken = config.accountKey
      ? undefined
      : await getAccessToken(config);
    const { data, ...rest } = args;
    const body = data instanceof Blob ? data : new Blob([data]);
    const { fileId, blobName, contentType, uploadExpiresAt } =
      await this.reserve(
        ctx,
        config,
        { ...rest, size: body.size },
        SERVER_SAS_TTL_MS,
      );
    const request = await this.serverRequest(
      config,
      config.container,
      blobName,
      "c",
      uploadExpiresAt,
      accessToken,
    );
    const response = await fetch(request.url, {
      method: "PUT",
      headers: {
        ...request.headers,
        "x-ms-blob-type": "BlockBlob",
        "content-type": contentType,
      },
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
   * Ready-made upload functions for use with `useUploadFile` from
   * `convex-azure-blob/react`. It also returns an internal `scanMalware` action for cron polling:
   *
   * ```ts
   * export const { generateUploadUrl, confirmUpload, scanMalware } = azure.clientApi({
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
          md5: v.optional(v.string()),
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
      renewUploadUrl: mutationGeneric({
        args: { fileId: v.string() },
        returns: uploadTicketValidator,
        handler: async (ctx, args): Promise<UploadTicket> => {
          const uploadedBy = await identify(ctx);
          return await this.renewUploadUrl(ctx, { ...args, uploadedBy });
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
      scanMalware: internalActionGeneric({
        args: { limit: v.optional(v.number()) },
        returns: v.number(),
        handler: async (ctx, args): Promise<number> =>
          await this.scanMalware(ctx, args.limit),
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
