import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const packageName = "agentbridgelens-extension";

export function validateVersion(version) {
  // Chrome requires one to four numeric components, each <= 65535.
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || version.split(".").some((part) => Number(part) > 65535)
      || version === "0.0.0") {
    throw new Error(`Version ${version} cannot be used in a Chrome extension manifest`);
  }
  return version;
}

export async function prepare(_config, { cwd, nextRelease, logger }) {
  const version = validateVersion(nextRelease.version);
  for (const path of ["packages/extension/package.json", "packages/extension/src/manifest.json"]) {
    const file = join(cwd, path);
    const json = JSON.parse(await readFile(file, "utf8"));
    json.version = version;
    await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  execFileSync("pnpm", ["zip"], { cwd, stdio: "inherit" });
  const built = JSON.parse(await readFile(join(cwd, "packages/extension/dist/manifest.json"), "utf8"));
  if (built.version !== version) throw new Error("Built manifest version does not match release version");
  const out = join(cwd, "release");
  await mkdir(out, { recursive: true });
  const filename = `${packageName}-${version}.zip`;
  await copyFile(join(cwd, `${packageName}.zip`), join(out, filename));
  const hash = createHash("sha256").update(await readFile(join(out, filename))).digest("hex");
  await writeFile(join(out, `${filename}.sha256`), `${hash}  ${filename}\n`);
  await writeFile(join(out, "release-notes.md"), nextRelease.notes ?? "");
  logger.log("Built %s", filename);
}
