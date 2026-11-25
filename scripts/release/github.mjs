import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (data) => createHash("sha256").update(data).digest("hex");

/** Publish the exact, already-verified Gitea output. Never build or overwrite. */
export async function publishGitHub({ repository, token, sha, ref, artifactsDir, apiUrl = "https://api.github.com" }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !token)
    throw new Error("A GitHub repository, release token and exact commit are required.");
  const manifestBytes = await readFile(join(artifactsDir, "BUILD-MANIFEST.json"));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.source?.commit !== sha || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error("Release manifest must identify this exact Gitea commit.");
  const stable = ref === `refs/tags/desktop-v${manifest.bridgeVersion}` || ref === `refs/tags/bridge-v${manifest.bridgeVersion}`;
  if ((!stable && ref !== "refs/heads/main") ||
      manifest.version !== (stable ? manifest.bridgeVersion : `${manifest.bridgeVersion}-dev.${sha.slice(0, 12)}`))
    throw new Error("GitHub release version must match the Gitea ref and commit.");
  const tag = stable ? ref.slice("refs/tags/".length) : `desktop-build-${manifest.version}`;
  const payloads = new Map();
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || payloads.has(file.name) || ["BUILD-MANIFEST.json", "SHA256SUMS"].includes(file.name))
      throw new Error("Invalid or duplicate release filename.");
    if (!(await lstat(join(artifactsDir, file.name))).isFile()) throw new Error(`Not a regular release file: ${file.name}`);
    const bytes = await readFile(join(artifactsDir, file.name));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error(`Release manifest checksum mismatch: ${file.name}`);
    payloads.set(file.name, bytes);
  }
  payloads.set("BUILD-MANIFEST.json", manifestBytes);
  const sums = await readFile(join(artifactsDir, "SHA256SUMS"));
  const expectedSums = [...payloads].map(([name, bytes]) => `${digest(bytes)}  ${name}`).sort();
  if (JSON.stringify(sums.toString().trim().split("\n").sort()) !== JSON.stringify(expectedSums))
    throw new Error("Release SHA256SUMS does not match the verified Gitea files.");
  payloads.set("SHA256SUMS", sums);

  const base = `${apiUrl.replace(/\/$/, "")}/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  async function request(url, { method = "GET", body, binary = false, allow404 = false } = {}) {
    const response = await fetch(url, {
      method, headers: { ...headers, ...(binary ? { Accept: "application/octet-stream" } : {}), ...(body ? { "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" } : {}) },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(`GitHub ${method} ${new URL(url).pathname} failed (HTTP ${response.status}): ${String(details.message ?? "Request rejected").slice(0, 300)}`);
    }
    return response.status === 204 ? null : binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  const tagRef = await request(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
  if (tagRef) {
    let object = tagRef.object;
    while (object.type === "tag") object = (await request(`${base}/git/tags/${object.sha}`)).object;
    if (object.type !== "commit" || object.sha !== sha) throw new Error("GitHub release tag points to a different commit.");
  } else await request(`${base}/git/refs`, { method: "POST", body: { ref: `refs/tags/${tag}`, sha } });

  let release = await request(`${base}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  if (!release) release = await request(`${base}/releases`, { method: "POST", body: {
    tag_name: tag, target_commitish: sha, name: stable ? tag : `Desktop build ${manifest.version}`,
    body: `Built and verified by Gitea from commit ${sha}.\n\nComponent version: ${manifest.bridgeVersion}.\nWindows executors were cross-compiled; Windows GUI acceptance was not run.\nChecksums and platform details: BUILD-MANIFEST.json and SHA256SUMS.`,
    draft: true, prerelease: !stable, make_latest: "false",
  } });
  const existing = new Map(release.assets.map((asset) => [asset.name, asset]));
  // Verify every existing asset before adding anything, so a retry cannot
  // silently replace an earlier release with a different build.
  for (const [name, bytes] of payloads) {
    const asset = existing.get(name);
    if (!asset) continue;
    const downloaded = await request(`${base}/releases/assets/${asset.id}`, { binary: true });
    if (digest(downloaded) !== digest(bytes)) throw new Error(`Immutable GitHub asset conflict: ${name}`);
  }
  for (const [name, bytes] of payloads) {
    if (existing.has(name)) continue;
    const uploadUrl = `${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(name)}`;
    const uploaded = await request(uploadUrl, { method: "POST", body: bytes });
    const downloaded = await request(`${base}/releases/assets/${uploaded.id}`, { binary: true });
    if (digest(downloaded) !== digest(bytes)) throw new Error(`GitHub download checksum mismatch: ${name}`);
    console.log(`Verified GitHub asset: ${name}`);
  }
  if (release.draft) release = await request(`${base}/releases/${release.id}`, { method: "PATCH", body: { draft: false, prerelease: !stable, make_latest: "false" } });
  console.log(`Published verified Gitea build: ${release.html_url}`);
  if (ref === `refs/tags/bridge-v${manifest.bridgeVersion}`) {
    await request(`${base}/dispatches`, { method: "POST", body: {
      event_type: "gitea-bridge-published", client_payload: { tag, sha },
    } });
    console.log(`Requested GitHub npm trusted publishing for ${tag}`);
  }
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await publishGitHub({
      repository: process.env.GH_RELEASE_REPOSITORY ?? "Erhao/AgentBridgeLens", token: process.env.GH_TOKEN,
      sha: process.env.GITEA_SHA, ref: process.env.GITEA_REF,
      artifactsDir: resolve(process.argv[2] ?? "artifacts"),
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
