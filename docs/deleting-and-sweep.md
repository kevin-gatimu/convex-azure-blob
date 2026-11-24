# Deleting files and the sweep

The sweep cron and its action, how deletes are retained and retried, and how to
tune the sweep. [Back to the README](../README.md)

Add a cron as a safety net. It deletes uploads that were never confirmed (after
an hour by default) and retries any delete that failed:

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly("sweep azure blobs", { minuteUTC: 17 }, internal.files.sweep, {});
crons.interval(
  "refresh Azure Blob user delegation key",
  { hours: 1 },
  internal.files.refreshUserDelegationKey,
  {},
);
export default crons;

// convex/files.ts
export const sweep = internalAction({
  args: { run: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> =>
    await azure.sweep(ctx, {
      continueWith: internal.files.sweep,
      run: args.run,
    }),
});

export const refreshUserDelegationKey = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await azure.refreshUserDelegationKey(ctx);
    return null;
  },
});
```

`azure.delete` is an alias of `purge`. After a delete, the row stays in the
`deleting` state until the file's recorded `uploadExpiresAt` plus a five-minute
clock-skew allowance, because that URL could otherwise re-create the blob. A
later sweep removes it. Changing client TTL settings does not shorten this
retention. Sweep atomically claims stale pending uploads before deleting them,
so a confirmation that commits first is not swept. Each sweep examines at most
1000 expired pending rows in expiry order while skipping those younger than the
age cutoff; if more than 1000 young rows sort ahead of an older one, it waits
until they age out.

Sweep claims up to `limit` files (default 100, clamped to 1-200) and deletes
with `concurrency` workers (default 8, a positive integer). A failed Azure
delete is deferred for one minute, doubling on each failure up to 24 hours, so
one failing blob does not monopolize later batches. A successful delete with a
live upload URL is deferred until its recorded expiry plus the clock-skew
allowance.

Pass an internal action as `continueWith` to drain a backlog: a full claimed
batch schedules it with `{ run: run + 1 }` at zero delay while
`run + 1 < maxRuns`. `run` defaults to 0 and `maxRuns` to 10; the action must
forward `run` and use the same sweep options on each invocation. A scheduler is
required only when using `continueWith`; existing callers with just `runQuery`
and `runMutation` still work. The return counts successful blob deletes
(including 404), not removed rows. The cron starts a fresh chain with `{}`.
