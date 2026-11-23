import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishGitHub } from "./github.mjs";

/** Recover a verified build for delivery, without recompiling immutable files. */
export async function restorePackages({ serverUrl, repository, token, version, sha, artifactsDir }) {
  const server = new URL(serverUrl);
  if (!["http:", "https:"].includes(server.protocol) || server.username || server.password || server.search || server.hash
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      || !/^[0-9A-Za-z.+-]+$/.test(version) || !/^[a-f0-9]{40}$/.test(sha) || !token)
    throw new Error("A Gitea repository, package version, exact commit and package token are required.");
  const owner = repository.split("/")[0];
  const base = `${server.href.replace(/\/$/, "")}/api/packages/${encodeURIComponent(owner)}/generic/agentbridgelens/${encodeURIComponent(version)}`;
  async function download(name) {
    const response = await fetch(`${base}/${encodeURIComponent(name)}`, {
      headers: { Authorization: `token ${token}` }, redirect: "error", signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Restore ${name} failed (HTTP ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }
  const bytes = await download("BUILD-MANIFEST.json"), manifest = JSON.parse(bytes);
  if (manifest.version !== version || manifest.source?.commit !== sha || manifest.source?.repository !== repository
      || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error("Retained build manifest does not match the requested version and commit.");
  const names = new Set(["BUILD-MANIFEST.json", "SHA256SUMS"]);
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || names.has(file.name)) throw new Error("Invalid retained filename.");
    names.add(file.name);
  }
  await mkdir(artifactsDir, { recursive: true });
  for (const file of manifest.files) {
    const contents = await download(file.name);
    if (contents.length !== file.bytes || createHash("sha256").update(contents).digest("hex") !== file.sha256)
      throw new Error(`Retained build checksum mismatch: ${file.name}`);
    await writeFile(join(artifactsDir, file.name), contents, { flag: "wx" });
  }
  await writeFile(join(artifactsDir, "BUILD-MANIFEST.json"), bytes, { flag: "wx" });
  await writeFile(join(artifactsDir, "SHA256SUMS"), await download("SHA256SUMS"), { flag: "wx" });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const artifactsDir = resolve(process.argv[2] ?? "artifacts");
    const manifest = await restorePackages({
      serverUrl: process.env.GITEA_SERVER_URL, repository: process.env.GITEA_REPOSITORY,
      token: process.env.GITEA_PACKAGES_TOKEN, version: process.env.SOURCE_VERSION,
      sha: process.env.SOURCE_SHA, artifactsDir,
    });
    await publishGitHub({ repository: "Erhao/AgentBridgeLens", token: process.env.GH_TOKEN,
      sha: manifest.source.commit,
      ref: manifest.version === manifest.bridgeVersion ? `refs/tags/desktop-v${manifest.bridgeVersion}` : "refs/heads/main",
      artifactsDir });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
