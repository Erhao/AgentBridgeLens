import { readFile, readdir, mkdir, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { desktopVersion } from "../release/desktop-version.mjs";
import { createZip } from "../release/updater-package.mjs";

const root = resolve(import.meta.dirname, "../..");
const version = await desktopVersion(root);
const out = join(root, "artifacts");
await mkdir(out, { recursive: true });
for (const arch of ["x64", "arm64"]) {
  const directory = join(root, "packages/bridge/windows-agent", `win-${arch}`);
  const entries = [];
  async function walk(dir, prefix = "") {
    for (const file of (await readdir(dir)).sort()) {
      const path = join(dir, file), name = `${prefix}${file}`, stat = await lstat(path);
      if (stat.isDirectory()) await walk(path, `${name}/`);
      else if (stat.isFile()) entries.push({ name, data: await readFile(path) });
      else throw new Error(`Unsupported Windows distribution entry: ${name}`);
    }
  }
  await walk(directory);
  await writeFile(join(out, `agentbridgelens-windows-${version}-${arch}.zip`), createZip(entries));
}
// Linux's executor is Python source, shipped with the same-version Bridge.
// This archive is also available separately for inspecting/installing it.
execFileSync("tar", ["--exclude=__pycache__", "--exclude=*.pyc", "-czf", join(out, `agentbridgelens-linux-${version}-x64.tgz`),
  "-C", join(root, "platforms/linux"), "agent"], { stdio: "inherit" });
