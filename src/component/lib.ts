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
import schema, { fileFields } from "./schema.js";

const MAX_METADATA_KEYS = 32;
const MAX_METADATA_VALUE_LENGTH = 1024;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_SWEEP_LIMIT = 200;

export const fileDoc = v.object({ fileId: v.id("files"), ...fileFields });
const metadataValidator = fileFields.metadata;

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
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    assertFileName(args.fileName);
    assertMetadata(args.metadata);
    return await ctx.db.insert("files", { ...args, status: "pending" });
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
  },
  returns: v.union(fileDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("files", args.fileId);
    if (!row || row.status === "deleting") return null;
    if (row.status === "ready") return toDoc(row);
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
      uploadExpiresAt: v.number(),
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
      uploadExpiresAt: row.uploadExpiresAt,
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
  args: { pendingBefore: v.number(), limit: v.number() },
  returns: v.array(
    v.object({
      fileId: v.id("files"),
      container: v.string(),
      blobName: v.string(),
      createdAt: v.number(),
      uploadExpiresAt: v.number(),
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
    const stale =
      deleting.length < limit
        ? await ctx.db
            .query("files")
            .withIndex("by_status_createdAt", (q) =>
              q.eq("status", "pending").lt("createdAt", args.pendingBefore),
            )
            .take(limit - deleting.length)
        : [];
    for (const row of stale) {
      await ctx.db.patch("files", row._id, { status: "deleting" });
    }
    return [...deleting, ...stale].map((row) => ({
      fileId: row._id,
      container: row.container,
      blobName: row.blobName,
      createdAt: row.createdAt,
      uploadExpiresAt: row.uploadExpiresAt,
    }));
  },
});
