/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      claimSweepable: FunctionReference<
        "mutation",
        "internal",
        { limit: number; pendingBefore: number },
        Array<{
          blobName: string;
          container: string;
          createdAt: number;
          fileId: string;
          uploadExpiresAt: number;
        }>,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          blobName: string;
          container: string;
          contentType: string;
          createdAt: number;
          fileName?: string;
          maxBytes: number;
          metadata?: Record<string, string>;
          uploadExpiresAt: number;
          uploadedBy: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { fileId: string },
        {
          blobName: string;
          container: string;
          contentType: string;
          createdAt: number;
          fileId: string;
          fileName?: string;
          maxBytes: number;
          metadata?: Record<string, string>;
          size?: number;
          status: "pending" | "ready" | "deleting";
          uploadExpiresAt: number;
          uploadedBy: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          uploadedBy?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            blobName: string;
            container: string;
            contentType: string;
            createdAt: number;
            fileId: string;
            fileName?: string;
            maxBytes: number;
            metadata?: Record<string, string>;
            size?: number;
            status: "pending" | "ready" | "deleting";
            uploadExpiresAt: number;
            uploadedBy: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      markDeleting: FunctionReference<
        "mutation",
        "internal",
        { fileId: string },
        {
          blobName: string;
          container: string;
          createdAt: number;
          uploadExpiresAt: number;
        } | null,
        Name
      >;
      markReady: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; onUpload?: string; size: number },
        {
          blobName: string;
          container: string;
          contentType: string;
          createdAt: number;
          fileId: string;
          fileName?: string;
          maxBytes: number;
          metadata?: Record<string, string>;
          size?: number;
          status: "pending" | "ready" | "deleting";
          uploadExpiresAt: number;
          uploadedBy: string;
        } | null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { fileId: string },
        null,
        Name
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          fileId: string;
          fileName?: string;
          metadata?: Record<string, string>;
        },
        boolean,
        Name
      >;
    };
  };
