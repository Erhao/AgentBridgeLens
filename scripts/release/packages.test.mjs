import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion, publishPackages } from "./packages.mjs";
import { packageUpdater } from "./updater-package.mjs";
import { restorePackages } from "./restore-packages.mjs";

const sha = "a".repeat(40);
const root = fileURLToPath(new URL("../../", import.meta.url));
test("release tags match the project version and main builds get unique development versions", () => {
  assert.equal(
    packageVersion("0.1.2", "refs/tags/desktop-v0.1.2", sha),
    "0.1.2",
  );
  assert.equal(
    packageVersion("0.1.2", "refs/heads/main", sha),
    "0.1.2-dev.aaaaaaaaaaaa",
  );
  assert.throws(() => packageVersion("0.1.2", "refs/tags/desktop-v9.0.0", sha));
  assert.throws(() => packageVersion("0.1.2", "refs/heads/feature", sha));
  assert.throws(() => packageVersion("0.1.2-beta.1", "refs/heads/main", sha));
  assert.throws(() => packageVersion("0.1.2", "refs/heads/main", "short"));
});

test("publishes native, Bridge and updater files, verifies downloads and refuses changed immutable bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "abm-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "agentbridgelens-macos-0.1.2-arm64.zip"), "native");
  await writeFile(join(dir, "agentbridgelens-windows-0.1.2-x64.zip"), "windows");
  await writeFile(join(dir, "agentbridgelens-linux-0.1.2-x64.tgz"), "linux");
  await writeFile(join(dir, "agentbridgelens-bridge-0.1.2.tgz"), "bridge");
  await packageUpdater(root, dir);
  const stored = new Map();
  let links = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "token test-secret") {
      res.writeHead(401).end();
      return;
    }
    if (req.url.endsWith("/-/link/AgentBridgeLens") && req.method === "POST") {
      links++;
      res.writeHead(links > 1 ? 400 : 201).end();
      return;
    }
    if (
      req.url === "/api/v1/packages/xinyu/generic/agentbridgelens/0.1.2" &&
      req.method === "GET"
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          repository: links ? { full_name: "xinyu/AgentBridgeLens" } : null,
        }),
      );
      return;
    }
    if (
      !req.url.startsWith("/api/packages/xinyu/generic/agentbridgelens/0.1.2/")
    ) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (stored.has(req.url)) {
        res.writeHead(409).end();
        return;
      }
      stored.set(req.url, Buffer.concat(chunks));
      res.writeHead(201).end();
      return;
    }
    if (req.method === "GET" && stored.has(req.url)) {
      res.end(stored.get(req.url));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    repository: "xinyu/AgentBridgeLens",
    token: "test-secret",
    version: "0.1.2",
    baseVersion: "0.1.2",
    nativeVersion: "0.1.2",
    sha,
    artifactsDir: dir,
  };
  const result = await publishPackages(config);
  assert.equal(result.files.length, 8);
  assert.equal(stored.size, 8);
  assert.equal(links, 1);
  const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
  assert.match(sums, /  BUILD-MANIFEST.json/);
  assert.doesNotMatch(sums, /artifacts\//);
  const manifest = JSON.parse(
    await readFile(join(dir, "BUILD-MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.source.commit, sha);
  assert.equal(manifest.nativeVersion, manifest.bridgeVersion);
  assert.deepEqual(manifest.nativePackages, [
    { name: "agentbridgelens-linux-0.1.2-x64.tgz", platform: "linux", architecture: "x64", version: "0.1.2" },
    { name: "agentbridgelens-macos-0.1.2-arm64.zip", platform: "macos", architecture: "arm64", version: "0.1.2" },
    { name: "agentbridgelens-windows-0.1.2-x64.zip", platform: "windows", architecture: "x64", version: "0.1.2" },
  ]);
  assert.equal(manifest.updater.name, "agentbridgelens-updater.zip");
  const updater = stored.get("/api/packages/xinyu/generic/agentbridgelens/0.1.2/agentbridgelens-updater.zip");
  const updaterHash = createHash("sha256").update(updater).digest("hex");
  assert.equal(stored.get("/api/packages/xinyu/generic/agentbridgelens/0.1.2/agentbridgelens-updater.zip.sha256").toString(),
    `${updaterHash}  agentbridgelens-updater.zip\n`);
  assert.match(sums, new RegExp(`${updaterHash}  agentbridgelens-updater.zip\\n`));
  const restored = join(dir, "restored");
  const restoredManifest = await restorePackages({ ...config, artifactsDir: restored });
  assert.equal(restoredManifest.source.commit, sha);
  for (const file of result.files)
    assert.deepEqual(await readFile(join(restored, file.name)), await readFile(join(dir, file.name)));
  await assert.rejects(restorePackages({ ...config, artifactsDir: join(dir, "wrong-commit"), sha: "b".repeat(40) }), /does not match/);
  await publishPackages(config);
  assert.equal(stored.size, 8);
  assert.equal(links, 1);
  await writeFile(
    join(dir, "agentbridgelens-macos-0.1.2-arm64.zip"),
    "changed",
  );
  await assert.rejects(publishPackages(config), /Immutable package conflict/);
  assert.equal(
    stored
      .get(
        "/api/packages/xinyu/generic/agentbridgelens/0.1.2/agentbridgelens-macos-0.1.2-arm64.zip",
      )
      .toString(),
    "native",
  );
  stored.set("/api/packages/xinyu/generic/agentbridgelens/0.1.2/agentbridgelens-updater.zip", Buffer.from("corrupt retained updater"));
  await assert.rejects(restorePackages({ ...config, artifactsDir: join(dir, "corrupt") }), /Retained build checksum mismatch/);
});

test("rejects missing updaters, mixed platform versions and corrupt checksums before any upload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "abl-registry-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    serverUrl: "http://127.0.0.1:1", repository: "xinyu/AgentBridgeLens", token: "test-secret",
    version: "0.1.2", baseVersion: "0.1.2", nativeVersion: "0.1.2", sha, artifactsDir: dir,
  };
  await writeFile(join(dir, "agentbridgelens-macos-0.1.2-arm64.zip"), "native");
  await writeFile(join(dir, "agentbridgelens-bridge-0.1.2.tgz"), "bridge");
  await assert.rejects(publishPackages(config), /semi-automatic updater/);
  await packageUpdater(root, dir);
  await assert.rejects(publishPackages({ ...config, nativeVersion: "0.2.0" }), /Native and Bridge versions must match/);
  await assert.rejects(publishPackages({ ...config, version: "9.0.0" }), /Registry version must match/);
  for (const platform of ["macos", "windows", "linux"]) {
    const file = join(dir, `agentbridgelens-${platform}-9.0.0-arm64.zip`);
    await writeFile(file, "wrong version");
    await assert.rejects(publishPackages(config), /Native archive must match desktop version/);
    await rm(file);
  }
  await rename(join(dir, "agentbridgelens-bridge-0.1.2.tgz"), join(dir, "agentbridgelens-bridge-9.0.0.tgz"));
  await assert.rejects(publishPackages(config), /versioned Bridge archive/);
  await rename(join(dir, "agentbridgelens-bridge-9.0.0.tgz"), join(dir, "agentbridgelens-bridge-0.1.2.tgz"));
  await writeFile(join(dir, "agentbridgelens-updater.zip.sha256"), "wrong checksum");
  await assert.rejects(publishPackages(config), /Updater SHA256 does not match/);
});
