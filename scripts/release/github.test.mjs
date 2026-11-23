import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishGitHub } from "./github.mjs";

const sha = "a".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, { stable = false, failUpload = false, wrongTag = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "abl-github-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("verified Gitea updater");
  const manifest = Buffer.from(JSON.stringify({
    version: stable ? "0.6.0" : "0.6.0-dev.aaaaaaaaaaaa", bridgeVersion: "0.6.0", source: { commit: sha },
    files: [{ name: "agentbridgelens-updater.zip", bytes: bytes.length, sha256: hash(bytes) }],
  }));
  await writeFile(join(dir, "agentbridgelens-updater.zip"), bytes);
  await writeFile(join(dir, "BUILD-MANIFEST.json"), manifest);
  await writeFile(join(dir, "SHA256SUMS"), `${hash(bytes)}  agentbridgelens-updater.zip\n${hash(manifest)}  BUILD-MANIFEST.json\n`);
  const state = { release: null, tag: wrongTag ? { object: { type: "commit", sha: "b".repeat(40) } } : null, writes: 0, bytes: new Map(), requests: 0 };
  const server = createServer(async (req, res) => {
    state.requests++;
    if (req.headers.authorization !== "Bearer test-secret") { res.writeHead(401).end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    const data = [];
    for await (const chunk of req) data.push(chunk);
    const body = Buffer.concat(data);
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method !== "GET") state.writes++;
    if (url.pathname.includes("/git/ref/tags/")) return state.tag ? json(state.tag) : json({}, 404);
    if (url.pathname.endsWith("/git/refs")) {
      const value = JSON.parse(body); state.tag = { object: { type: "commit", sha: value.sha } }; return json(state.tag, 201);
    }
    if (url.pathname.includes("/releases/tags/")) return state.release ? json(state.release) : json({}, 404);
    if (url.pathname.endsWith("/releases") && req.method === "POST") {
      state.release = { ...JSON.parse(body), id: 1, assets: [], upload_url: `${url.origin}/upload{?name,label}`, html_url: "https://github.com/Erhao/AgentBridgeLens/releases/test" };
      return json(state.release, 201);
    }
    if (url.pathname === "/upload") {
      if (failUpload) return json({}, 503);
      const name = url.searchParams.get("name"), id = state.bytes.size + 1;
      state.bytes.set(id, body); const asset = { id, name }; state.release.assets.push(asset); return json(asset, 201);
    }
    if (url.pathname.includes("/releases/assets/")) {
      res.end(state.bytes.get(Number(url.pathname.split("/").at(-1)))); return;
    }
    if (url.pathname.endsWith("/releases/1") && req.method === "PATCH") {
      Object.assign(state.release, JSON.parse(body)); return json(state.release);
    }
    json({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { repository: "Erhao/AgentBridgeLens", token: "test-secret", sha,
    ref: stable ? "refs/tags/desktop-v0.6.0" : "refs/heads/main", artifactsDir: dir, apiUrl: `http://127.0.0.1:${server.address().port}` };
  return { state, config, dir };
}

test("uploads exact Gitea bytes, verifies downloads, publishes a prerelease and retries without writes", async (t) => {
  const { config, state, dir } = await fixture(t);
  const release = await publishGitHub(config);
  assert.equal(release.prerelease, true);
  assert.equal(release.draft, false);
  assert.equal(release.make_latest, "false");
  assert.equal(release.assets.length, 3);
  assert.equal(release.target_commitish, sha);
  assert.equal(state.bytes.get(1).toString(), "verified Gitea updater");
  const writes = state.writes;
  await publishGitHub(config);
  assert.equal(state.writes, writes);
  state.bytes.set(1, Buffer.from("changed on GitHub"));
  await assert.rejects(publishGitHub(config), /Immutable GitHub asset conflict/);
  assert.equal(state.writes, writes);
  const requests = state.requests;
  await writeFile(join(dir, "agentbridgelens-updater.zip"), "changed locally");
  await assert.rejects(publishGitHub(config), /manifest checksum mismatch/);
  assert.equal(state.requests, requests);
});

test("stable desktop releases do not become the latest extension release", async (t) => {
  const { config } = await fixture(t, { stable: true });
  const release = await publishGitHub(config);
  assert.equal(release.tag_name, "desktop-v0.6.0");
  assert.equal(release.prerelease, false);
  assert.equal(release.make_latest, "false");
});

test("upload failure leaves the GitHub release as a draft", async (t) => {
  const { config, state } = await fixture(t, { failUpload: true });
  await assert.rejects(publishGitHub(config), /HTTP 503/);
  assert.equal(state.release.draft, true);
});

test("wrong tag commits and wrong local checksums stop delivery", async (t) => {
  const { config, state, dir } = await fixture(t, { wrongTag: true });
  await assert.rejects(publishGitHub(config), /different commit/);
  assert.equal(state.writes, 0);
  await writeFile(join(dir, "SHA256SUMS"), "invalid");
  await assert.rejects(publishGitHub(config), /SHA256SUMS does not match/);
  assert.equal(state.writes, 0);
});
