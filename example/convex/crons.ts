import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Safety net: removes blobs of abandoned uploads and of deletes whose blob removal failed.
crons.hourly("sweep azure blobs", { minuteUTC: 17 }, internal.photos.sweep, {});
crons.interval(
  "refresh Azure Blob user delegation key",
  { hours: 24 },
  internal.photos.refreshUserDelegationKey,
  {},
);
crons.interval(
  "check Azure Blob malware scan results",
  { minutes: 1 },
  internal.photos.scanMalware,
  {},
);

export default crons;
