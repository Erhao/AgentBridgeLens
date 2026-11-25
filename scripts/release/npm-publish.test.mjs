import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { releaseVersion, verifyNpmArtifact, needsPublication } from "./npm-publish.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = Buffer.from("exact Gitea package"), filename = "agentbridgelens-0.6.0.tgz", sha = "a".repeat(40);
  const manifestBytes = Buffer.from(JSON.stringify({ version: "0.6.0", bridgeVersion: "0.6.0", source: { commit: sha },
    files: [{ name: filename, bytes: bytes.length, sha256: digest(bytes) }] }));
  const checksumBytes = Buffer.from(`${digest(bytes)}  ${filename}\n`);
  return { tag: "bridge-v0.6.0", sha, bytes, manifestBytes, checksumBytes,
    sumsBytes: Buffer.from(`${checksumBytes}${digest(manifestBytes)}  BUILD-MANIFEST.json\n`),
    pkg: { name: "agentbridgelens", version: "0.6.0", repository: { url: "git+https://github.com/Erhao/AgentBridgeLens.git" } },
  };
}
test("npm publishing verifies the Gitea commit, version, byte count and both checksum files", () => {
  const f = fixture(), verified = verifyNpmArtifact(f);
  assert.equal(verified.filename, "agentbridgelens-0.6.0.tgz");
  assert.equal(needsPublication(null, verified.integrity), true);
  assert.equal(needsPublication({ dist: { integrity: verified.integrity } }, verified.integrity), false);
  assert.throws(() => needsPublication({ dist: { integrity: "different" } }, verified.integrity), /different bytes/);
});
test("npm publishing rejects altered bytes, wrong tags, wrong source commits and package identity", () => {
  const f = fixture();
  for (const tag of ["main", "bridge-v0.6.0;echo", "bridge-v0.6.0-beta", "bridge-v00.6.0"])
    assert.throws(() => releaseVersion(tag), /exact stable/);
  assert.throws(() => verifyNpmArtifact({ ...f, sha: "b".repeat(40) }), /exact release/);
  assert.throws(() => verifyNpmArtifact({ ...f, bytes: Buffer.from("changed") }), /build manifest/);
  assert.throws(() => verifyNpmArtifact({ ...f, checksumBytes: Buffer.from("changed") }), /checksums/);
  assert.throws(() => verifyNpmArtifact({ ...f, sumsBytes: f.checksumBytes }), /checksums/);
  assert.throws(() => verifyNpmArtifact({ ...f, pkg: { ...f.pkg, version: "0.7.0" } }), /identity/);
  assert.throws(() => verifyNpmArtifact({ ...f, pkg: { ...f.pkg, repository: { url: "https://example.com/other.git" } } }), /identity/);
});
