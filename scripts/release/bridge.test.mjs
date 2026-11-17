import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBridgeRelease, validateWindowsExecutors } from "./bridge.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bridge releases require an exact matching stable package version and independent tag", () => {
  assert.equal(validateBridgeRelease("bridge-v0.3.0", { name: "agentbridgelens", version: "0.3.0" }), "0.3.0");
  for (const [tag, pkg] of [
    ["main", { name: "agentbridgelens", version: "0.3.0" }],
    ["bridge-v0.2.0", { name: "agentbridgelens", version: "0.3.0" }],
    ["extension-v0.3.0", { name: "agentbridgelens", version: "0.3.0" }],
    ["bridge-v0.3.0", { name: "other", version: "0.3.0" }],
    ["bridge-v0.3.0-beta.1", { name: "agentbridgelens", version: "0.3.0-beta.1" }],
  ]) assert.throws(() => validateBridgeRelease(tag, pkg), /tag must match/);
});

test("Bridge packaging requires both complete Windows executors and matching PE architectures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "abl-windows-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(validateWindowsExecutors(directory), /ENOENT/);
  for (const [architecture, machine] of [["x64", 0x8664], ["arm64", 0xaa64]]) {
    const native = join(directory, "windows-agent", `win-${architecture}`);
    await mkdir(native, { recursive: true });
    for (const filename of ["AgentBridgeLens.Windows.dll", "AgentBridgeLens.Windows.deps.json",
      "AgentBridgeLens.Windows.runtimeconfig.json", "Interop.UIAutomationClient.dll", "coreclr.dll", "ThirdPartyNotices.txt"])
      await writeFile(join(native, filename), "fixture");
    const exe = Buffer.alloc(128);
    exe.write("MZ"); exe.writeUInt32LE(64, 0x3c); exe.write("PE\0\0", 64); exe.writeUInt16LE(machine, 68);
    await writeFile(join(native, "AgentBridgeLens.Windows.exe"), exe);
  }
  await validateWindowsExecutors(directory);
  await writeFile(join(directory, "windows-agent/win-arm64/AgentBridgeLens.Windows.exe"), "not a PE executable");
  await assert.rejects(validateWindowsExecutors(directory), /wrong PE architecture/);
});
