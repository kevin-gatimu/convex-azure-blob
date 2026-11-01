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
        { limit: number; now?: number; pendingBefore: number },
        Array<{
          blobName: string;
          container: string;
          createdAt: number;
          fileId: string;
          uploadExpiresAt?: number;
        }>,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          uploadExpiresAt: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        },
        string,
        Name
      >;
      deferMalwareScan: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; nextCheckAt: number; now: number },
        null,
        Name
      >;
      dueMalwareScans: FunctionReference<
        "query",
        "internal",
        { limit: number; now: number },
        Array<{
          attempts: number;
          blobName: string;
          cleanupUntil?: number;
          container: string;
          deadlineAt: number;
          fileId: string;
          onUpload?: string;
          phase?: "cleanup";
          size: number;
          snapshot?: string;
          uploadExpiresAt?: number;
        }>,
        Name
      >;
      finishMalwareCleanup: FunctionReference<
        "mutation",
        "internal",
        { fileId: string },
        null,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { fileId: string },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      getByBlobName: FunctionReference<
        "query",
        "internal",
        { blobName: string; container: string },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      getUserDelegationKey: FunctionReference<
        "query",
        "internal",
        { accountName: string; now: number },
        {
          keyValue: string;
          signedExpiry: string;
          signedObjectId: string;
          signedService: string;
          signedStart: string;
          signedTenantId: string;
          signedVersion: string;
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
            blockSize?: number;
            container: string;
            contentType: string;
            createdAt: number;
            expectedSize?: number;
            fileId: string;
            fileName?: string;
            malwareScanRequired?: boolean;
            maxBytes: number;
            md5?: string;
            metadata?: Record<string, string>;
            size?: number;
            snapshot?: string;
            status:
              | "pending"
              | "scanning"
              | "ready"
              | "rejected"
              | "scan_timed_out"
              | "deleting";
            uploadExpiresAt?: number;
            uploadMode?: "blocks";
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
          uploadExpiresAt?: number;
        } | null,
        Name
      >;
      markReady: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; onUpload?: string; size: number; snapshot?: string },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      markScanning: FunctionReference<
        "mutation",
        "internal",
        {
          deadlineAt: number;
          fileId: string;
          now: number;
          onUpload?: string;
          size: number;
          snapshot?: string;
        },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      markScanRejected: FunctionReference<
        "mutation",
        "internal",
        { cleanupUntil: number; fileId: string; now: number },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      markScanTimedOut: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; now: number },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
        Name
      >;
      recordSnapshot: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; snapshot: string },
        string | null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { fileId: string },
        null,
        Name
      >;
      renewUpload: FunctionReference<
        "mutation",
        "internal",
        { expiresAt: number; fileId: string; now: number; uploadedBy: string },
        {
          blobName: string;
          blockSize?: number;
          container: string;
          contentType: string;
          createdAt: number;
          expectedSize?: number;
          fileId: string;
          fileName?: string;
          malwareScanRequired?: boolean;
          maxBytes: number;
          md5?: string;
          metadata?: Record<string, string>;
          size?: number;
          snapshot?: string;
          status:
            | "pending"
            | "scanning"
            | "ready"
            | "rejected"
            | "scan_timed_out"
            | "deleting";
          uploadExpiresAt?: number;
          uploadMode?: "blocks";
          uploadedBy: string;
        } | null,
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
      upsertUserDelegationKey: FunctionReference<
        "mutation",
        "internal",
        {
          accountName: string;
          keyValue: string;
          signedExpiry: string;
          signedObjectId: string;
          signedService: string;
          signedStart: string;
          signedTenantId: string;
          signedVersion: string;
        },
        null,
        Name
      >;
    };
  };
