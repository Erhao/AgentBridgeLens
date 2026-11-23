import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageUpdater } from "./updater-package.mjs";
import { extractZip } from "../update/update-extension.mjs";

test("updater ZIP contains all platform launchers and source-identical scripts with a matching checksum", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "abl-updater-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await packageUpdater(root, dir);
  const zip = await readFile(join(dir, "agentbridgelens-updater.zip"));
  const extracted = join(dir, "extracted");
  await mkdir(extracted);
  await extractZip(zip, extracted);
  for (const file of ["update-extension.mjs", "update-extension.cmd", "update-extension.command", "update-extension.sh", "README.txt"])
    assert.deepEqual(await readFile(join(extracted, file)), await readFile(join(root, "scripts/update", file)));
  assert.equal(await readFile(join(dir, "agentbridgelens-updater.zip.sha256"), "utf8"),
    `${createHash("sha256").update(zip).digest("hex")}  agentbridgelens-updater.zip\n`);
});
