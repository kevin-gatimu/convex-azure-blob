import { readdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await rm(new URL("dist/", root), { recursive: true, force: true });
for (const name of await readdir(root)) {
  if (name.endsWith(".tsbuildinfo")) {
    await rm(new URL(name, root));
  }
}
