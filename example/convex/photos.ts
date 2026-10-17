import { AzureBlob } from "convex-azure-blob";
import type { Auth } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";

// One instance per container or prefix. Configuration comes from the AZURE_BLOB_* variables.
export const azure = new AzureBlob(components.azureBlob, {
  maxBytes: 5 * 1024 * 1024,
  pathPrefix: "photos",
});

// The example has no sign-in, so everyone is the same demo user. A real app returns null when
// there is no identity, which refuses the upload.
async function currentUser(ctx: { auth: Auth }) {
  return (await ctx.auth.getUserIdentity())?.subject ?? "demo-user";
}

// `useUploadFile(api.photos)` in the browser calls these two.
export const { generateUploadUrl, confirmUpload } = azure.clientApi({
  identify: currentUser,
  checkUpload: async (ctx, { uploadedBy }) => {
    const existing = await ctx.db
      .query("photos")
      .withIndex("by_owner", (q) => q.eq("owner", uploadedBy))
      .take(100);
    if (existing.length >= 100) {
      throw new ConvexError("You can keep at most 100 photos");
    }
  },
  onUpload: async (ctx, file) => {
    await ctx.runMutation(internal.photos.attach, {
      fileId: file.fileId,
      owner: file.uploadedBy,
    });
  },
});

export const attach = internalMutation({
  args: { fileId: v.string(), owner: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("photos", args);
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("photos"),
      fileId: v.string(),
      caption: v.optional(v.string()),
      fileName: v.optional(v.string()),
      size: v.optional(v.number()),
      url: v.union(v.string(), v.null()),
      downloadUrl: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const photos = await ctx.db.query("photos").order("desc").take(50);
    return await Promise.all(
      photos.map(async (photo) => {
        const file = await azure.getFile(ctx, photo.fileId);
        return {
          id: photo._id,
          fileId: photo.fileId,
          caption: photo.caption,
          fileName: file?.fileName,
          size: file?.size,
          url: file ? await azure.urlForFile(file) : null,
          downloadUrl: file
            ? await azure.urlForFile(file, { download: true })
            : null,
        };
      }),
    );
  },
});

export const setCaption = mutation({
  args: { id: v.id("photos"), caption: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("photos", args.id);
    if (!photo || photo.owner !== (await currentUser(ctx))) {
      throw new ConvexError("Photo not found");
    }
    await ctx.db.patch("photos", args.id, {
      caption: args.caption.slice(0, 200),
    });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("photos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("photos", args.id);
    if (!photo || photo.owner !== (await currentUser(ctx))) {
      throw new ConvexError("Photo not found");
    }
    // The file stops being served in the same transaction that drops the app's reference;
    // the blob itself is deleted right after, and the hourly sweep retries any failure.
    await ctx.db.delete("photos", args.id);
    await azure.markForDeletion(ctx, photo.fileId);
    await ctx.scheduler.runAfter(0, internal.photos.purge, {
      fileId: photo.fileId,
    });
    return null;
  },
});

export const purge = internalAction({
  args: { fileId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => await azure.purge(ctx, args.fileId),
});

export const sweep = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await azure.sweep(ctx),
});
