import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createZip } from "../release/updater-package.mjs";
import { activate, update, rollback, extractZip, validateExtension, parseArgs, main } from "./update-extension.mjs";

function files(version, extra = {}) {
  return [
    { name: "manifest.json", data: JSON.stringify({ name: "AgentBridgeLens", manifest_version: 3, version,
      background: { service_worker: "worker.js" }, action: { default_popup: "popup.html" }, ...extra }) },
    { name: "worker.js", data: `// v${version}` },
    { name: "popup.html", data: "<html>popup</html>" },
  ];
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "abl-updater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function install(directory, version, extra) {
  await mkdir(directory, { recursive: true });
  for (const { name, data } of files(version, extra)) await writeFile(join(directory, name), data);
}
function releaseFetch(version, { zip = createZip(files(version)), badHash = false, failDownload = false } = {}) {
  const requests = [];
  const name = `agentbridgelens-extension-${version}.zip`;
  const hash = badHash ? "0".repeat(64) : createHash("sha256").update(zip).digest("hex");
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/latest")) return new Response(JSON.stringify({ tag_name: `extension-v${version}`, assets: [{ name }, { name: `${name}.sha256` }] }));
    if (url.endsWith(".sha256")) return new Response(`${hash}  ${name}\n`);
    if (failDownload) return new Response("unavailable", { status: 503 });
    return new Response(zip);
  };
  return { fetchImpl, requests };
}

test("update preserves install path, removes stale files, keeps backup and supports rollback", async (t) => {
  const root = await fixture(t), target = join(root, "原插件 with spaces");
  await install(target, "1.4.0");
  await writeFile(join(target, "obsolete.js"), "old");
  const release = releaseFetch("1.5.0");
  const result = await update(target, release);
  assert.equal(result.changed, true);
  assert.equal((await validateExtension(target)).version, "1.5.0");
  assert.equal(existsSync(join(target, "obsolete.js")), false);
  assert.equal((await validateExtension(`${target}.abl-backup`)).version, "1.4.0");
  await rollback(target);
  assert.equal((await validateExtension(target)).version, "1.4.0");
  assert.equal((await validateExtension(`${target}.abl-backup`)).version, "1.5.0");
  assert.equal(await readFile(join(target, "obsolete.js"), "utf8"), "old");
  await rollback(target);
  assert.equal((await validateExtension(target)).version, "1.5.0");
});

test("new installation, repeat update, check-only and newer local versions", async (t) => {
  const root = await fixture(t), target = join(root, "extension");
  const check = releaseFetch("1.5.0");
  assert.equal((await update(target, { ...check, check: true })).changed, false);
  assert.equal(existsSync(target), false);
  assert.equal(check.requests.length, 1);
  assert.equal((await update(target, releaseFetch("1.5.0"))).firstInstall, true);
  const repeat = releaseFetch("1.5.0");
  assert.equal((await update(target, repeat)).changed, false);
  assert.equal(repeat.requests.length, 1);
  const older = releaseFetch("1.4.0");
  assert.equal((await update(target, older)).changed, false);
  assert.equal(older.requests.length, 1);
  await update(target, releaseFetch("1.6.0"));
  await update(target, releaseFetch("1.7.0"));
  assert.equal((await validateExtension(`${target}.abl-backup`)).version, "1.6.0");
});

test("checksum, network, version and identity failures leave original installation intact", async (t) => {
  const root = await fixture(t), target = join(root, "extension");
  await install(target, "1.4.0");
  for (const release of [
    releaseFetch("1.5.0", { badHash: true }),
    releaseFetch("1.5.0", { failDownload: true }),
    releaseFetch("1.5.0", { zip: createZip(files("1.6.0")) }),
    releaseFetch("1.5.0", { zip: createZip(files("1.5.0", { key: "new-identity" })) }),
    releaseFetch("1.5.0", { zip: createZip(files("1.5.0").filter((entry) => entry.name !== "worker.js")) }),
  ]) {
    await assert.rejects(update(target, release));
    assert.equal((await validateExtension(target)).version, "1.4.0");
    assert.equal(existsSync(`${target}.abl-backup`), false);
  }
});

test("unsafe archives cannot escape staging or overwrite original files", async (t) => {
  const root = await fixture(t);
  for (const entries of [
    [{ name: "../escape", data: "x" }], [{ name: "/absolute", data: "x" }],
    [{ name: "C:/windows", data: "x" }], [{ name: "a\\escape", data: "x" }],
    [{ name: "NUL.txt", data: "x" }], [{ name: "file. ", data: "x" }],
    [{ name: "link", data: "target", mode: 0o120777 }],
    [{ name: "file.js", data: "1" }, { name: "FILE.js", data: "2" }],
  ]) {
    const staged = await mkdtemp(join(root, "stage-"));
    await assert.rejects(extractZip(createZip(entries), staged));
  }
  assert.equal(existsSync(join(root, "escape")), false);
  await assert.rejects(extractZip(Buffer.from("invalid ZIP"), root));
});

test("failed directory switch restores the current version and its older backup", async (t) => {
  const root = await fixture(t), target = join(root, "extension"), staged = join(root, "staged");
  await install(target, "1.3.0");
  await update(target, releaseFetch("1.4.0"));
  await install(staged, "1.5.0");
  await assert.rejects(activate(staged, target, {
    renameFile: async (from, to) => {
      if (from === staged) throw new Error("Simulated file lock");
      await rename(from, to);
    },
  }), /Simulated file lock/);
  assert.equal((await validateExtension(target)).version, "1.4.0");
  assert.equal((await validateExtension(`${target}.abl-backup`)).version, "1.3.0");
  assert.equal((await validateExtension(staged)).version, "1.5.0");
});

test("unrelated folders and unowned backups are preserved", async (t) => {
  const root = await fixture(t), target = join(root, "extension");
  await mkdir(target);
  await writeFile(join(target, "personal.txt"), "keep");
  await assert.rejects(update(target, releaseFetch("1.5.0")));
  assert.equal(await readFile(join(target, "personal.txt"), "utf8"), "keep");
  await install(target, "1.4.0");
  await install(`${target}.abl-backup`, "1.3.0");
  await assert.rejects(update(target, releaseFetch("1.5.0")));
  assert.equal((await validateExtension(target)).version, "1.4.0");
  assert.equal((await validateExtension(`${target}.abl-backup`)).version, "1.3.0");
});

test("rollback recovers a missing install directory after an interrupted switch", async (t) => {
  const root = await fixture(t), target = join(root, "extension");
  await install(target, "1.4.0");
  await update(target, releaseFetch("1.5.0"));
  await rm(target, { recursive: true });
  await assert.rejects(update(target, releaseFetch("1.6.0")), /--rollback/);
  await rollback(target);
  assert.equal((await validateExtension(target)).version, "1.4.0");
  assert.equal(existsSync(`${target}.abl-backup`), false);
});

test("arguments accept spaced paths and reject incomplete or conflicting options", () => {
  assert.equal(parseArgs(["--dir", "folder with spaces", "--check"]).directory, resolve("folder with spaces"));
  assert.equal(parseArgs(["--rollback"]).rollback, true);
  for (const args of [["--dir"], ["--dir", "--check"], ["--rollback", "--check"], ["--unknown"]]) assert.throws(() => parseArgs(args));
});

test("a second updater refuses an existing lock without changing the installation", async (t) => {
  const root = await fixture(t), target = join(root, "extension");
  await install(target, "1.4.0");
  await writeFile(`${target}.abl-update.lock`, "another process");
  await assert.rejects(main(["--dir", target]), /锁文件/);
  assert.equal((await validateExtension(target)).version, "1.4.0");
  assert.equal(await readFile(`${target}.abl-update.lock`, "utf8"), "another process");
});
