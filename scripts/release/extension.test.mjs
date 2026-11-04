import { extractZip, validateExtension } from "../update/update-extension.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { prepare, validateVersion } from "./extension.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const logger = { log() {} };

test("release versions obey Chrome numeric limits and SemVer", () => {
  for (const version of ["1.0.0", "0.1.0", "65535.65535.65535"]) {
    assert.equal(validateVersion(version), version);
  }
  for (const version of ["0.0.0", "65536.0.0", "1.0.0-beta.1", "01.2.3", "1.2", "-1.2.3", undefined]) {
    assert.throws(() => validateVersion(version));
  }
});

test("commit history determines patch, minor, major or no release", async () => {
  for (const [messages, expected] of [
    [["fix: correct connection hint"], "patch"],
    [["fix: correct hint", "feat: add remote transport"], "minor"],
    [["feat: replace protocol\n\nBREAKING CHANGE: old clients must upgrade"], "major"],
    [["docs: explain installation", "ci: configure release"], null],
  ]) {
    const actual = await analyzeCommits({}, {
      cwd: root, logger, commits: messages.map((message) => ({ message })),
    });
    assert.equal(actual, expected);
  }
});

// Read local ZIP records to inspect what users actually download.
function zipEntry(zip, wanted) {
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    const data = zip.subarray(start, start + size);
    if (name === wanted) {
      assert.ok(method === 0 || method === 8);
      return method === 8 ? inflateRawSync(data) : data;
    }
    offset = start + size;
  }
  throw new Error(`Missing ZIP entry: ${wanted}`);
}

test("prepare builds a real versioned ZIP with manifest, scripts and matching checksum", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bridgelens-release-"));
  try {
    await mkdir(join(cwd, "packages"));
    await cp(join(root, "scripts/update"), join(cwd, "scripts/update"), { recursive: true });
    await cp(join(root, "packages/extension"), join(cwd, "packages/extension"), {
      recursive: true,
      filter: (path) => !["node_modules", "dist"].includes(basename(path)),
    });
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    await symlink(join(root, "packages/extension/node_modules"), join(cwd, "packages/extension/node_modules"), "dir");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await writeFile(join(cwd, "package.json"), JSON.stringify(pkg));
    await cp(join(root, "pnpm-workspace.yaml"), join(cwd, "pnpm-workspace.yaml"));
    await cp(join(root, "tsconfig.base.json"), join(cwd, "tsconfig.base.json"));

    await prepare({}, { cwd, nextRelease: { version: "2.3.4", notes: "Test release" }, logger });
    const name = "agentbridgelens-extension-2.3.4.zip";
    const zip = await readFile(join(cwd, "release", name));
    const extracted = join(cwd, "extracted");
    await mkdir(extracted);
    await extractZip(zip, extracted);
    assert.equal((await validateExtension(extracted)).version, "2.3.4");
    const manifest = JSON.parse(zipEntry(zip, "manifest.json"));
    assert.equal(manifest.version, "2.3.4");
    assert.ok(zipEntry(zip, manifest.background.service_worker).length > 0);
    assert.ok(zipEntry(zip, manifest.action.default_popup).length > 0);
    assert.deepEqual(zip, await readFile(join(cwd, "agentbridgelens-extension.zip")));
    assert.equal(await readFile(join(cwd, "release", `${name}.sha256`), "utf8"),
      `${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
    assert.equal(await readFile(join(cwd, "release/release-notes.md"), "utf8"), "Test release");
    const source = JSON.parse(await readFile(join(cwd, "packages/extension/package.json"), "utf8"));
    assert.equal(source.version, "2.3.4");
    const updater = await readFile(join(cwd, "release/agentbridgelens-updater.zip"));
    assert.match(zipEntry(updater, "update-extension.mjs").toString(), /export async function update/);
    assert.match(zipEntry(updater, "update-extension.cmd").toString(), /node/);
    assert.match(zipEntry(updater, "update-extension.command").toString(), /node/);
    assert.match(zipEntry(updater, "README.txt").toString(), /原目录/);
    assert.equal(await readFile(join(cwd, "release/agentbridgelens-updater.zip.sha256"), "utf8"),
      `${createHash("sha256").update(updater).digest("hex")}  agentbridgelens-updater.zip\n`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
