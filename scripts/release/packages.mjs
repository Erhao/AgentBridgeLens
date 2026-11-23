import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopVersion, validateDesktopVersion } from "./desktop-version.mjs";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const segment = (value) => encodeURIComponent(value);

export function packageVersion(baseVersion, ref, sha) {
  validateDesktopVersion(baseVersion);
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Expected a full Git commit SHA.");
  if (ref.startsWith("refs/tags/")) {
    if (ref !== `refs/tags/desktop-v${baseVersion}`)
      throw new Error("Release tag must exactly match the project version.");
    return baseVersion;
  }
  if (ref !== "refs/heads/main")
    throw new Error("Only main and version tags may publish packages.");
  return `${baseVersion}-dev.${sha.slice(0, 12)}`;
}

/** Files are immutable. Re-running is allowed only when downloaded bytes match. */
export async function publishPackages({
  serverUrl,
  repository,
  token,
  version,
  sha,
  artifactsDir,
  baseVersion,
  nativeVersion,
  distribution = "desktop",
}) {
  const server = new URL(serverUrl);
  if (
    !["https:", "http:"].includes(server.protocol) ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  )
    throw new Error("Invalid Gitea server URL.");
  const base = server.href.replace(/\/$/, "");
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p)))
    throw new Error("Invalid owner/repository.");
  if (!token) throw new Error("GITEA_PACKAGES_TOKEN is required.");
  if (!/^[0-9A-Za-z.+-]+$/.test(version) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid package version or commit.");
  validateDesktopVersion(baseVersion);
  if (nativeVersion !== baseVersion)
    throw new Error("Native and Bridge versions must match before publishing.");
  if (version !== baseVersion && version !== `${baseVersion}-dev.${sha.slice(0, 12)}`)
    throw new Error("Registry version must match the desktop version and commit.");
  const [owner, repo] = parts;
  if (!["desktop", "bridge"].includes(distribution)) throw new Error("Unknown distribution.");
  const name = distribution === "bridge" ? "agentbridgelens-npm" : "agentbridgelens";
  const archives = (await readdir(artifactsDir))
    .filter((n) => /\.(zip|tgz)$/.test(n))
    .sort();
  const bridge = distribution === "bridge" ? `agentbridgelens-${baseVersion}.tgz` : `agentbridgelens-bridge-${baseVersion}.tgz`;
  const updater = "agentbridgelens-updater.zip";
  if (!archives.includes(bridge) || !archives.includes(updater))
    throw new Error("Expected a versioned Bridge archive and semi-automatic updater ZIP.");
  const native = archives.filter((file) => file !== bridge && file !== updater);
  if (!native.length && distribution === "desktop") throw new Error("Expected at least one native desktop archive.");
  if (native.length && distribution === "bridge") throw new Error("Unexpected archive in the npm distribution.");
  const nativePackages = native.map((file) => {
    const match = file.match(/^agentbridgelens-(macos|windows|linux)-([0-9.]+)-(arm64|x86_64|x64)\.(zip|tgz)$/);
    if (!match || match[2] !== baseVersion
        || (match[1] === "macos" && !["arm64", "x86_64"].includes(match[3]))
        || (match[1] === "windows" && !["arm64", "x64"].includes(match[3]))
        || (match[1] !== "linux" && match[4] !== "zip"))
      throw new Error(`Native archive must match desktop version ${baseVersion} and platform: ${file}`);
    return { name: file, platform: match[1], architecture: match[3], version: baseVersion };
  });
  const entries = [...archives, `${updater}.sha256`, ...(distribution === "bridge" ? [`${bridge}.sha256`] : [])].sort();
  const payloads = new Map();
  const files = [];
  for (const file of entries) {
    if (!(await lstat(join(artifactsDir, file))).isFile())
      throw new Error(`Archive must be a regular file: ${file}`);
    const bytes = await readFile(join(artifactsDir, file));
    if (!bytes.length) throw new Error(`Empty archive: ${file}`);
    payloads.set(file, bytes);
    files.push({ name: file, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (payloads.get(`${updater}.sha256`).toString() !== `${digest(payloads.get(updater))}  ${updater}\n`)
    throw new Error("Updater SHA256 does not match its ZIP; refusing to publish.");
  const manifest = Buffer.from(
    JSON.stringify(
      {
        package: name,
        version,
        source: { repository, commit: sha },
        nativeVersion,
        bridgeVersion: baseVersion,
        nativePackages,
        updater: { name: updater, purpose: "Semi-automatic Chrome extension update; reload the extension after updating." },
        files,
      },
      null,
      2,
    ) + "\n",
  );
  payloads.set("BUILD-MANIFEST.json", manifest);
  const checksums = Buffer.from(
    [...payloads]
      .map(([file, bytes]) => `${digest(bytes)}  ${file}\n`)
      .join(""),
  );
  payloads.set("SHA256SUMS", checksums);
  await writeFile(join(artifactsDir, "BUILD-MANIFEST.json"), manifest);
  await writeFile(join(artifactsDir, "SHA256SUMS"), checksums);
  const headers = { Authorization: `token ${token}` };
  const options = {
    headers,
    redirect: "error",
    // Give each request its own deadline; native runtimes can be hundreds of
    // megabytes, and one shared signal would expire midway through the batch.
    get signal() { return AbortSignal.timeout(300_000); },
  };
  const packageBase = `${base}/api/packages/${segment(owner)}/generic/${name}/${segment(version)}`;
  let linked = false;
  for (const [file, bytes] of payloads) {
    const url = `${packageBase}/${segment(file)}`;
    const upload = await fetch(url, {
      ...options,
      method: "PUT",
      body: bytes,
      headers: { ...headers, "Content-Type": "application/octet-stream" },
    });
    if (upload.status !== 201 && upload.status !== 409)
      throw new Error(`Upload ${file} failed (HTTP ${upload.status}).`);
    await upload.arrayBuffer();
    const download = await fetch(url, options);
    if (!download.ok)
      throw new Error(`Verify ${file} failed (HTTP ${download.status}).`);
    const received = Buffer.from(await download.arrayBuffer());
    if (received.length !== bytes.length || digest(received) !== digest(bytes))
      throw new Error(
        `Immutable package conflict or checksum mismatch for ${file}; existing files were not overwritten.`,
      );
    if (!linked) {
      const metadataUrl = `${base}/api/v1/packages/${segment(owner)}/generic/${name}/${segment(version)}`;
      const metadata = await fetch(metadataUrl, options);
      if (!metadata.ok)
        throw new Error(
          `Read package association failed (HTTP ${metadata.status}).`,
        );
      const existingRepo = (await metadata.json()).repository;
      if (existingRepo?.full_name !== repository) {
        if (existingRepo)
          throw new Error(
            "Package is already linked to another repository; refusing to change its association.",
          );
        const link = await fetch(
          `${base}/api/v1/packages/${segment(owner)}/generic/${name}/-/link/${segment(repo)}`,
          { ...options, method: "POST" },
        );
        if (link.status !== 201)
          throw new Error(
            `Link package to repository failed (HTTP ${link.status}).`,
          );
        await link.arrayBuffer();
        const check = await fetch(metadataUrl, options);
        if (
          !check.ok ||
          (await check.json()).repository?.full_name !== repository
        )
          throw new Error("Repository association was not verified.");
      }
      linked = true;
    }
    console.log(`Verified ${file}: ${digest(bytes)}`);
  }
  const result = {
    version,
    commit: sha,
    packageUrl: `${base}/${segment(owner)}/-/packages/generic/${name}/${segment(version)}`,
    files: [...payloads.keys()].map((file) => ({
      name: file,
      downloadUrl: `${packageBase}/${segment(file)}`,
    })),
  };
  console.log(`Published and verified ${result.packageUrl}`);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const root = resolve(import.meta.dirname, "../..");
    const baseVersion = await desktopVersion(root);
    const sha = process.env.GITEA_SHA ?? "";
    const ref = process.env.GITEA_REF ?? "";
    const distribution = process.argv[2] === "bridge" ? "bridge" : "desktop";
    if (distribution === "bridge" && ref !== `refs/tags/bridge-v${baseVersion}`)
      throw new Error("Bridge release tag must match the desktop version.");
    await publishPackages({
      serverUrl: process.env.GITEA_SERVER_URL ?? "",
      repository: process.env.GITEA_REPOSITORY ?? "",
      token: process.env.GITEA_PACKAGES_TOKEN,
      version: distribution === "bridge" ? baseVersion : packageVersion(
        baseVersion,
        ref,
        sha,
      ),
      baseVersion,
      sha,
      nativeVersion: JSON.parse(
        await readFile(join(root, "platforms/macos/version.json"), "utf8"),
      ).version,
      artifactsDir: join(root, "artifacts"),
      distribution,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
