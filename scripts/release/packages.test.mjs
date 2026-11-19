import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageVersion, publishPackages } from "./packages.mjs";

const sha = "a".repeat(40);
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
  assert.equal(packageVersion("0.1.2", "refs/heads/desktop/macos-app", sha), "0.1.2-preview.aaaaaaaaaaaa");
  assert.throws(() => packageVersion("0.1.2", "refs/heads/feature", sha));
});

test("publishes four files, links the repo, verifies downloads and refuses changed immutable bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "abm-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "agentbridgelens-macos-0.2.0-arm64.dmg"), "native");
  await writeFile(join(dir, "agentbridgelens-bridge-0.1.2.tgz"), "bridge");
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
    nativeVersion: "0.2.0",
    sha,
    artifactsDir: dir,
  };
  const result = await publishPackages(config);
  assert.equal(result.files.length, 4);
  assert.equal(stored.size, 4);
  assert.equal(links, 1);
  const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
  assert.match(sums, /  BUILD-MANIFEST.json/);
  assert.doesNotMatch(sums, /artifacts\//);
  const manifest = JSON.parse(
    await readFile(join(dir, "BUILD-MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.source.commit, sha);
  await publishPackages(config);
  assert.equal(stored.size, 4);
  assert.equal(links, 1);
  await writeFile(
    join(dir, "agentbridgelens-macos-0.2.0-arm64.dmg"),
    "changed",
  );
  await assert.rejects(publishPackages(config), /Immutable package conflict/);
  assert.equal(
    stored
      .get(
        "/api/packages/xinyu/generic/agentbridgelens/0.1.2/agentbridgelens-macos-0.2.0-arm64.dmg",
      )
      .toString(),
    "native",
  );
});
