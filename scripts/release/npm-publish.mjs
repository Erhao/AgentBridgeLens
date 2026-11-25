import { createHash } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseVersion(tag) {
  if (!/^bridge-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? ""))
    throw new Error("Expected an exact stable bridge-vX.Y.Z tag");
  return tag.slice(8);
}
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");

/** Refuse repacking or a release whose build commit differs from its tag. */
export function verifyNpmArtifact({ tag, sha, manifestBytes, sumsBytes, checksumBytes, bytes, pkg }) {
  const version = releaseVersion(tag), filename = `agentbridgelens-${version}.tgz`;
  const manifest = JSON.parse(manifestBytes);
  if (!/^[a-f0-9]{40}$/.test(sha) || manifest.source?.commit !== sha ||
      manifest.version !== version || manifest.bridgeVersion !== version)
    throw new Error("Build manifest must match the exact release tag and commit");
  const listed = manifest.files?.filter(file => file.name === filename);
  if (listed?.length !== 1 || listed[0].sha256 !== hash("sha256", bytes) || listed[0].bytes !== bytes.length)
    throw new Error("Package does not match the Gitea build manifest");
  const checksum = `${hash("sha256", bytes)}  ${filename}`;
  const manifestSum = `${hash("sha256", manifestBytes)}  BUILD-MANIFEST.json`;
  const sums = sumsBytes.toString().trim().split("\n");
  if (checksumBytes.toString().trim() !== checksum || !sums.includes(checksum) || !sums.includes(manifestSum))
    throw new Error("Release checksums do not match");
  if (pkg.name !== "agentbridgelens" || pkg.version !== version ||
      !["git+https://github.com/Erhao/AgentBridgeLens.git", "https://github.com/Erhao/AgentBridgeLens.git"].includes(pkg.repository?.url))
    throw new Error("npm package identity does not match this release");
  return { version, filename, integrity: `sha512-${hash("sha512", bytes)}` };
}

export function needsPublication(metadata, integrity) {
  if (metadata === null) return true;
  if (metadata.dist?.integrity !== integrity) throw new Error("npm version already exists with different bytes");
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tag = process.env.BRIDGE_TAG;
    const version = releaseVersion(tag), directory = resolve(process.argv[2] ?? "release");
    const filename = `agentbridgelens-${version}.tgz`, archive = join(directory, filename);
    const pkg = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
    const verified = verifyNpmArtifact({ tag, sha: process.env.BRIDGE_SHA,
      manifestBytes: await readFile(join(directory, "BUILD-MANIFEST.json")),
      sumsBytes: await readFile(join(directory, "SHA256SUMS")),
      checksumBytes: await readFile(`${archive}.sha256`), bytes: await readFile(archive), pkg,
    });
    const response = await fetch(`https://registry.npmjs.org/agentbridgelens/${version}?verify=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 404) throw new Error(`npm registry check failed: HTTP ${response.status}`);
    const publish = needsPublication(response.status === 404 ? null : await response.json(), verified.integrity);
    if (process.argv.includes("--require-published") && publish) throw new Error("npm version is not published yet");
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\nfilename=${filename}\n`);
    console.log(`Verified Gitea artifact ${filename}; npm ${publish ? "publication required" : "contains the identical package"}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
