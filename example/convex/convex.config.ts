import { defineApp } from "convex/server";
import azureBlob from "convex-azure-blob/convex.config.js";

const app = defineApp();
app.use(azureBlob);

export default app;
