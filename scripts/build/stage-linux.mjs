import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "platforms/linux/agent"),
  target = join(root, "packages/bridge/linux-agent");
await mkdir(target, { recursive: true });
for (const name of await readdir(source))
  if (name.endsWith(".py"))
    await copyFile(join(source, name), join(target, name));
