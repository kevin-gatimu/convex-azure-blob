import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { azure } from "./photos.js";

const http = httpRouter();
const secret = process.env.AZURE_BLOB_EVENT_GRID_SECRET;

http.route({
  path: "/azure-blob/events",
  method: "POST",
  handler: secret
    ? azure.eventGridHandler({
        secret,
        onUpload: internal.photos.attach,
      })
    : httpAction(
        async () =>
          new Response("Event Grid secret is not configured", {
            status: 503,
          }),
      ),
});

export default http;
