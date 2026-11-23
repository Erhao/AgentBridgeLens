import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function validateDesktopVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || version.split(".").some((part) => Number(part) > 65535))
    throw new Error("Desktop version must be a stable numeric X.Y.Z version.");
  return version;
}

// Bridge is the version source for all desktop distributions. The extension
// keeps its own semantic-release lifecycle and is deliberately not rewritten.
export async function desktopVersion(root, { write = false } = {}) {
  const version = validateDesktopVersion(JSON.parse(
    await readFile(join(root, "packages/bridge/package.json"), "utf8"),
  ).version);
  const sources = [
    ["platforms/macos/version.json", /("version"\s*:\s*")[^"]+(")/, version],
    ["platforms/macos/Info.plist", /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/, version],
    ["platforms/macos/Sources/AgentBridgeMac/BuildInfo.swift", /(\?\?\s*")[^"]+(")/, version],
    ["platforms/windows/AgentBridgeLens.Windows.csproj", /(<Version>)[^<]+(<\/Version>)/, version],
    ["platforms/windows/app.manifest", /(<assemblyIdentity version=")[^"]+(")/, `${version}.0`],
  ];
  const pending = [];
  for (const [file, pattern, expected] of sources) {
    const source = await readFile(join(root, file), "utf8");
    const match = source.match(pattern);
    if (!match) throw new Error(`Missing desktop version in ${file}.`);
    const updated = source.replace(pattern, (_match, prefix, suffix) => `${prefix}${expected}${suffix}`);
    if (updated !== source) pending.push([file, updated]);
  }
  if (pending.length && !write)
    throw new Error(`Desktop versions must match Bridge ${version}: ${pending.map(([file]) => file).join(", ")}. Run node scripts/release/desktop-version.mjs --write.`);
  for (const [file, updated] of pending) await writeFile(join(root, file), updated);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? "--check";
    if (!["--check", "--write"].includes(mode)) throw new Error("Usage: desktop-version.mjs [--check|--write]");
    console.log(await desktopVersion(resolve(import.meta.dirname, "../.."), { write: mode === "--write" }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
