import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The app owns its references to files; the component owns the files themselves.
  photos: defineTable({
    fileId: v.string(),
    owner: v.string(),
    caption: v.optional(v.string()),
  })
    .index("by_fileId", ["fileId"])
    .index("by_owner", ["owner"]),
});
