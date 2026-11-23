import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVersion, validateDesktopVersion } from "./desktop-version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("all desktop source versions match Bridge", async () => {
  const pkg = JSON.parse(await readFile(join(root, "packages/bridge/package.json"), "utf8"));
  assert.equal(await desktopVersion(root), pkg.version);
});

test("desktop version rejects versions unsupported by native metadata", () => {
  for (const value of [undefined, "01.2.3", "1.2", "1.2.3-beta.1", "1.2.65536"])
    assert.throws(() => validateDesktopVersion(value));
});

test("a Bridge version change requires synchronizing every native source without modifying the extension", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "abl-desktop-version-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ["platforms/macos", "platforms/windows"]) {
    await cp(join(root, file), join(dir, file), {
      recursive: true,
      filter: (path) => !/[\\/](node_modules|\.build|bin|obj)([\\/]|$)/.test(path),
    });
  }
  await mkdir(join(dir, "packages/bridge"), { recursive: true });
  await mkdir(join(dir, "packages/extension"), { recursive: true });
  await writeFile(join(dir, "packages/bridge/package.json"), JSON.stringify({ version: "2.3.4" }));
  const extension = '{"version":"9.8.7"}\n';
  await writeFile(join(dir, "packages/extension/package.json"), extension);
  await assert.rejects(desktopVersion(dir), /Desktop versions must match Bridge 2.3.4/);
  assert.equal(await desktopVersion(dir, { write: true }), "2.3.4");
  assert.equal(await desktopVersion(dir), "2.3.4");
  assert.match(await readFile(join(dir, "platforms/windows/app.manifest"), "utf8"), /version="2.3.4.0"/);
  assert.match(await readFile(join(dir, "platforms/macos/Info.plist"), "utf8"), /<string>2.3.4<\/string>/);
  assert.equal(await readFile(join(dir, "packages/extension/package.json"), "utf8"), extension);
  // Missing version declarations must fail instead of silently skipping a platform.
  await writeFile(join(dir, "platforms/windows/AgentBridgeLens.Windows.csproj"), "<Project />");
  await assert.rejects(desktopVersion(dir, { write: true }), /Missing desktop version/);
});
