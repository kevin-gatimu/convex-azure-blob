// Apps reach these as `components.azureBlob.lib.<fn>`, usually through the `AzureBlob` client class.
import { paginator } from "convex-helpers/server/pagination";
import {
  type FunctionHandle,
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import schema, { fileFields, userDelegationKeyFields } from "./schema.js";

const MAX_METADATA_KEYS = 32;
const MAX_METADATA_VALUE_LENGTH = 1024;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_SWEEP_LIMIT = 200;
const MAX_SWEEP_SCAN = 1000;

export const fileDoc = v.object({ fileId: v.id("files"), ...fileFields });
const metadataValidator = fileFields.metadata;
const userDelegationKeyValidator = v.object(userDelegationKeyFields);

function toDoc(row: Doc<"files">) {
  const { _id, _creationTime: _, ...rest } = row;
  return { fileId: _id, ...rest };
}

function assertFileName(fileName: string | undefined) {
  if (fileName !== undefined && fileName.length > MAX_FILE_NAME_LENGTH) {
    throw new ConvexError(
      `File names are limited to ${MAX_FILE_NAME_LENGTH} characters`,
    );
  }
}

function assertMetadata(metadata: Record<string, string> | undefined) {
  if (!metadata) return;
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new ConvexError(`Metadata is limited to ${MAX_METADATA_KEYS} keys`);
  }
  for (const [key, value] of entries) {
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new ConvexError(
        `Metadata value "${key}" exceeds ${MAX_METADATA_VALUE_LENGTH} characters`,
      );
    }
  }
}

/** Reserves a file in the `pending` state. The blob does not exist yet. */
export const create = mutation({
  args: {
    container: v.string(),
    blobName: v.string(),
    contentType: v.string(),
    maxBytes: v.number(),
    uploadedBy: v.string(),
    fileName: v.optional(v.string()),
    metadata: metadataValidator,
    createdAt: v.number(),
    uploadExpiresAt: v.number(),
    uploadMode: fileFields.uploadMode,
    expectedSize: fileFields.expectedSize,
    blockSize: fileFields.blockSize,
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    assertFileName(args.fileName);
    assertMetadata(args.metadata);
    if (
      args.uploadMode === "blocks" &&
      (!Number.isSafeInteger(args.expectedSize) ||
        !args.expectedSize ||
        args.expectedSize <= 0 ||
        args.expectedSize > args.maxBytes ||
        !Number.isSafeInteger(args.blockSize) ||
        !args.blockSize ||
        args.blockSize < 8 * 1024 * 1024 ||
        args.blockSize > 4000 * 1024 * 1024 ||
        Math.ceil(args.expectedSize / args.blockSize) > 50_000)
    )
      throw new ConvexError("Invalid block upload size");
    return await ctx.db.insert("files", { ...args, status: "pending" });
  },
});

/** Extends only a pending session, never a file already claimed for deletion. */
export const renewUpload = mutation({
  args: {
    fileId: v.string(),
    uploadedBy: v.string(),
    now: v.number(),
    expiresAt: v.number(),
  },
  returns: v.union(fileDoc, v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("files", args.fileId);
    const row = id ? await ctx.db.get("files", id) : null;
    if (
      !id ||
      !row ||
      row.uploadedBy !== args.uploadedBy ||
      row.status !== "pending" ||
      row.uploadExpiresAt === undefined
    )
      return null;
    if (
      !Number.isFinite(args.now) ||
      !Number.isFinite(args.expiresAt) ||
      args.expiresAt <= args.now ||
      args.expiresAt > args.now + 7 * 24 * 60 * 60 * 1000
    )
      throw new ConvexError("Invalid upload expiry");
    // Earlier-issued SAS URLs stay valid until their own expiry, so cleanup must not undercut it.
    const uploadExpiresAt = Math.max(row.uploadExpiresAt, args.expiresAt);
    await ctx.db.patch("files", id, { uploadExpiresAt });
    return toDoc({ ...row, uploadExpiresAt });
  },
});

/** Records the first immutable snapshot so confirmation retries validate the same bytes. */
export const recordSnapshot = mutation({
  args: { fileId: v.id("files"), snapshot: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("files", args.fileId);
    if (!row || row.status === "deleting" || row.uploadMode !== "blocks")
      return null;
    if (row.snapshot) return row.snapshot;
    if (row.status !== "pending" || !Number.isFinite(Date.parse(args.snapshot)))
      throw new ConvexError("Invalid upload snapshot");
    await ctx.db.patch("files", args.fileId, { snapshot: args.snapshot });
    return args.snapshot;
  },
});

export const get = query({
  // A string, not an id: apps pass ids that came from browsers, and a malformed one is just unknown.
  args: { fileId: v.string() },
  returns: v.union(fileDoc, v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("files", args.fileId);
    const row = id ? await ctx.db.get("files", id) : null;
    return row ? toDoc(row) : null;
  },
});

export const getUserDelegationKey = query({
  args: { accountName: v.string(), now: v.number() },
  returns: v.union(userDelegationKeyValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("userDelegationKeys")
      .withIndex("by_accountName", (q) => q.eq("accountName", args.accountName))
      .unique();
    if (!row) return null;
    const startsAt = Date.parse(row.signedStart);
    const expiresAt = Date.parse(row.signedExpiry);
    if (
      !Number.isFinite(startsAt) ||
      startsAt > args.now ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= args.now
    ) {
      return null;
    }
    const { _id, _creationTime, accountName: _, ...key } = row;
    return key;
  },
});

export const upsertUserDelegationKey = mutation({
  args: {
    accountName: v.string(),
    ...userDelegationKeyFields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { accountName, ...key } = args;
    const existing = await ctx.db
      .query("userDelegationKeys")
      .withIndex("by_accountName", (q) => q.eq("accountName", accountName))
      .unique();
    if (existing) {
      await ctx.db.patch("userDelegationKeys", existing._id, key);
    } else {
      await ctx.db.insert("userDelegationKeys", { accountName, ...key });
    }
    return null;
  },
});

/** Ready files, newest first, optionally only those of one uploader. */
export const list = query({
  args: {
    uploadedBy: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(fileDoc),
  handler: async (ctx, args) => {
    const files = paginator(ctx.db, schema).query("files");
    const { uploadedBy } = args;
    const indexed =
      uploadedBy === undefined
        ? files.withIndex("by_status_createdAt", (q) => q.eq("status", "ready"))
        : files.withIndex("by_uploadedBy_status", (q) =>
            q.eq("uploadedBy", uploadedBy).eq("status", "ready"),
          );
    const result = await indexed.order("desc").paginate(args.paginationOpts);
    return { ...result, page: result.page.map(toDoc) };
  },
});

/** Replaces the display name and/or metadata of a file that is not being deleted. */
export const update = mutation({
  args: {
    fileId: v.string(),
    fileName: v.optional(v.string()),
    metadata: metadataValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("files", args.fileId);
    const row = id ? await ctx.db.get("files", id) : null;
    if (!id || !row || row.status === "deleting") return false;
    assertFileName(args.fileName);
    assertMetadata(args.metadata);
    const patch: Partial<Doc<"files">> = {};
    if (args.fileName !== undefined) patch.fileName = args.fileName;
    if (args.metadata !== undefined) patch.metadata = args.metadata;
    await ctx.db.patch("files", id, patch);
    return true;
  },
});

/** Commits the ready transition and the app's attachment in one transaction. */
export const markReady = mutation({
  args: {
    fileId: v.id("files"),
    size: v.number(),
    onUpload: v.optional(v.string()),
    snapshot: v.optional(v.string()),
  },
  returns: v.union(fileDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("files", args.fileId);
    if (!row || row.status === "deleting") return null;
    if (row.status === "ready") return toDoc(row);
    if (
      row.uploadMode === "blocks" &&
      (!row.snapshot ||
        args.snapshot !== row.snapshot ||
        args.size !== row.expectedSize ||
        args.size > row.maxBytes)
    )
      throw new ConvexError("Unverified block upload");
    await ctx.db.patch("files", args.fileId, {
      status: "ready",
      size: args.size,
    });
    if (args.onUpload) {
      await ctx.runMutation(
        args.onUpload as FunctionHandle<"mutation", { fileId: string }>,
        { fileId: args.fileId },
      );
    }
    return toDoc({ ...row, status: "ready", size: args.size });
  },
});

/** Stops the file being served until its blob is removed; null when the file is unknown. */
export const markDeleting = mutation({
  args: { fileId: v.string() },
  returns: v.union(
    v.object({
      container: v.string(),
      blobName: v.string(),
      createdAt: v.number(),
      uploadExpiresAt: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("files", args.fileId);
    const row = id ? await ctx.db.get("files", id) : null;
    if (!id || !row) return null;
    if (row.status !== "deleting")
      await ctx.db.patch("files", id, { status: "deleting" });
    return {
      container: row.container,
      blobName: row.blobName,
      createdAt: row.createdAt,
      ...(row.uploadExpiresAt !== undefined
        ? { uploadExpiresAt: row.uploadExpiresAt }
        : {}),
    };
  },
});

export const remove = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get("files", args.fileId))
      await ctx.db.delete("files", args.fileId);
    return null;
  },
});

/** Atomically claims stale pending uploads, so confirmation cannot race the selection. */
export const claimSweepable = mutation({
  args: {
    pendingBefore: v.number(),
    limit: v.number(),
    now: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      fileId: v.id("files"),
      container: v.string(),
      blobName: v.string(),
      createdAt: v.number(),
      uploadExpiresAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(Math.floor(args.limit), MAX_SWEEP_LIMIT),
    );
    const deleting = await ctx.db
      .query("files")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "deleting"))
      .take(limit);
    const expired: Doc<"files">[] = [];
    if (deleting.length < limit) {
      const wanted = limit - deleting.length;
      let scanned = 0;
      // Young rows with short expiries sort first; skip them rather than letting them fill the limit.
      for await (const row of ctx.db
        .query("files")
        .withIndex("by_status_uploadExpiresAt", (q) =>
          q
            .eq("status", "pending")
            .lt("uploadExpiresAt", args.now ?? args.pendingBefore),
        )) {
        if (row.createdAt < args.pendingBefore) expired.push(row);
        scanned += 1;
        if (expired.length >= wanted || scanned >= MAX_SWEEP_SCAN) break;
      }
    }
    for (const row of expired) {
      await ctx.db.patch("files", row._id, { status: "deleting" });
    }
    return [...deleting, ...expired].map((row) => ({
      fileId: row._id,
      container: row.container,
      blobName: row.blobName,
      createdAt: row.createdAt,
      ...(row.uploadExpiresAt !== undefined
        ? { uploadExpiresAt: row.uploadExpiresAt }
        : {}),
    }));
  },
});
