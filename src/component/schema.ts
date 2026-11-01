import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** A file may pass through scanning before ready, or remain rejected/timed out until deleted. */
export const fileStatus = v.union(
  v.literal("pending"),
  v.literal("scanning"),
  v.literal("ready"),
  v.literal("rejected"),
  v.literal("scan_timed_out"),
  v.literal("deleting"),
);

export const fileFields = {
  /** Container the blob lives in, so one deployment can use several containers. */
  container: v.string(),
  /** Server-generated: `[prefix/]<uuid>.<ext>`. Callers never choose it. */
  blobName: v.string(),
  contentType: v.string(),
  /** Set from the blob's own properties when the upload is confirmed. */
  size: v.optional(v.number()),
  maxBytes: v.number(),
  /** Opaque to the component: the app decides who an uploader is. */
  uploadedBy: v.string(),
  /** Whether this file must pass Defender for Storage scanning before serving. */
  malwareScanRequired: v.optional(v.boolean()),
  /** The name the user gave the file, for display and downloads. Never used in the blob name. */
  fileName: v.optional(v.string()),
  /** App-defined string metadata. */
  metadata: v.optional(v.record(v.string(), v.string())),
  status: fileStatus,
  createdAt: v.number(),
  /** Expiry of the create-only SAS; optional for files created before this field existed. */
  uploadExpiresAt: v.optional(v.number()),
  uploadMode: v.optional(v.literal("blocks")),
  expectedSize: v.optional(v.number()),
  blockSize: v.optional(v.number()),
  snapshot: v.optional(v.string()),
};

export const userDelegationKeyFields = {
  keyValue: v.string(),
  signedObjectId: v.string(),
  signedTenantId: v.string(),
  signedStart: v.string(),
  signedExpiry: v.string(),
  signedService: v.string(),
  signedVersion: v.string(),
};

export default defineSchema({
  files: defineTable(fileFields)
    .index("by_container_blobName", ["container", "blobName"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_status_uploadExpiresAt", ["status", "uploadExpiresAt"])
    .index("by_uploadedBy_status", ["uploadedBy", "status"]),
  malwareScans: defineTable({
    fileId: v.id("files"),
    nextCheckAt: v.number(),
    deadlineAt: v.number(),
    attempts: v.number(),
    phase: v.optional(v.literal("cleanup")),
    cleanupUntil: v.optional(v.number()),
    onUpload: v.optional(v.string()),
  })
    .index("by_nextCheckAt", ["nextCheckAt"])
    .index("by_fileId", ["fileId"]),
  userDelegationKeys: defineTable({
    accountName: v.string(),
    ...userDelegationKeyFields,
  }).index("by_accountName", ["accountName"]),
});
