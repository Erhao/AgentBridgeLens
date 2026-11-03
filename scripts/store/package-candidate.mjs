// Build a review candidate without changing source version files or publishing.
// Usage: node scripts/store/package-candidate.mjs 1.0.1
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateVersion } from "../release/extension.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const version = validateVersion(process.argv[2]);
execFileSync("pnpm", ["zip"], { cwd: root, stdio: "inherit" });
const manifestPath = join(root, "packages/extension/dist/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
execFileSync(process.execPath, ["packages/extension/scripts/zip-dist.mjs"], { cwd: root, stdio: "inherit" });
const output = join(root, "release/chrome-store");
await mkdir(output, { recursive: true });
const filename = `agentbridgelens-chrome-store-${version}.zip`;
await copyFile(join(root, "agentbridgelens-extension.zip"), join(output, filename));
await copyFile(join(root, "packages/extension/public/icons/icon128.png"), join(output, "icon128.png"));
const sha256 = createHash("sha256").update(await readFile(join(output, filename))).digest("hex");
await writeFile(join(output, `${filename}.sha256`), `${sha256}  ${filename}\n`);
console.log(JSON.stringify({ filename, version, sha256, output }, null, 2));
