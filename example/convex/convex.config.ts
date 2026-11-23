import { defineApp } from "convex/server";
import azureBlobStorage from "convex-azure-blob-storage/convex.config.js";

const app = defineApp();
app.use(azureBlobStorage);

export default app;
