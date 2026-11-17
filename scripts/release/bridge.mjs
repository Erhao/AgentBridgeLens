import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function validateBridgeRelease(tag, pkg) {
  if (pkg.name !== "agentbridgelens" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)
      || tag !== `bridge-v${pkg.version}`) throw new Error("Bridge tag must match packages/bridge/package.json: bridge-vX.Y.Z");
  return pkg.version;
}

export async function validateWindowsExecutors(directory) {
  for (const [architecture, machine] of [["x64", 0x8664], ["arm64", 0xaa64]]) {
    const native = join(directory, "windows-agent", `win-${architecture}`);
    for (const filename of ["AgentBridgeLens.Windows.dll", "AgentBridgeLens.Windows.deps.json",
      "AgentBridgeLens.Windows.runtimeconfig.json", "Interop.UIAutomationClient.dll", "coreclr.dll", "ThirdPartyNotices.txt"]) {
      await access(join(native, filename));
    }
    const exe = await readFile(join(native, "AgentBridgeLens.Windows.exe"));
    const offset = exe.length >= 64 ? exe.readUInt32LE(0x3c) : exe.length;
    if (exe.toString("ascii", 0, 2) !== "MZ" || offset + 6 > exe.length ||
      exe.toString("ascii", offset, offset + 4) !== "PE\0\0" || exe.readUInt16LE(offset + 4) !== machine) {
      throw new Error(`Windows executor is missing or has the wrong PE architecture: win-${architecture}`);
    }
  }
}

export async function packageBridge(cwd, tag) {
  const directory = join(cwd, "packages/bridge");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const version = validateBridgeRelease(tag, pkg);
  // CI downloads these exact-commit artifacts before packaging. Never publish
  // a nominally Windows-capable npm package with missing or wrong-arch workers.
  await validateWindowsExecutors(directory);
  const out = join(cwd, "release");
  await mkdir(out, { recursive: true });
  execFileSync("pnpm", ["--dir", directory, "build"], { cwd, stdio: "inherit" });
  // Pack exactly the artifact that will be installed, smoke-tested, and published.
  execFileSync("npm", ["pack", "--pack-destination", out], { cwd: directory, stdio: "inherit" });
  const filename = `agentbridgelens-${version}.tgz`;
  const hash = createHash("sha256").update(await readFile(join(out, filename))).digest("hex");
  await writeFile(join(out, `${filename}.sha256`), `${hash}  ${filename}\n`);
  return filename;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await packageBridge(process.cwd(), process.argv[2]);
}
