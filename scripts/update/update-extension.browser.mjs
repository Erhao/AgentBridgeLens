// Optional real-Chrome persistence check. Build the extension first.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createZip } from "../release/updater-package.mjs";
import { update, rollback } from "./update-extension.mjs";

const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || "playwright");
const root = await mkdtemp(join(tmpdir(), "abl-update-browser-"));
const target = join(root, "fixed-extension");
const source = fileURLToPath(new URL("../../packages/extension/dist/", import.meta.url));
await cp(source, target, { recursive: true });
const entries = [];
async function walk(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(directory, entry.name), `${name}/`);
    else {
      let data = await readFile(join(directory, entry.name));
      if (name === "manifest.json") {
        const manifest = JSON.parse(data);
        manifest.version = "2.0.0";
        data = Buffer.from(JSON.stringify(manifest));
      }
      entries.push({ name, data });
    }
  }
}
await walk(source);
const zip = createZip(entries), name = "agentbridgelens-extension-2.0.0.zip";
const fetchImpl = async (url) => {
  if (url.endsWith("/latest")) return new Response(JSON.stringify({ tag_name: "extension-v2.0.0", assets: [{ name }, { name: `${name}.sha256` }] }));
  if (url.endsWith(".sha256")) return new Response(`${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
  return new Response(zip);
};
let context;
try {
  context = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium",
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${target}`, `--load-extension=${target}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const settings = {
    bridgeProfiles: [{ id: "saved", name: "保留的桥接服务", host: "192.168.1.38", port: 29222, token: "test-token", enabled: true }],
    bridgeConsent: false, activityDisplayEnabled: false, activityToastEnabled: false,
  };
  await worker.evaluate((settings) => chrome.storage.local.set(settings), settings);
  const originalVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  async function reloadAndVerify(expectedVersion) {
    const error = await manager.evaluate((id) => new Promise((done) => {
      chrome.developerPrivate.reload(id, { failQuietly: true }, () => done(chrome.runtime.lastError?.message));
    }), id);
    assert.equal(error, undefined);

    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${id}/src/popup/index.html`);
    assert.equal(await settingsPage.evaluate(() => chrome.runtime.id), id, "same extension ID after replacing files");
    assert.equal(await settingsPage.evaluate(() => chrome.runtime.getManifest().version), expectedVersion);
    const stored = await settingsPage.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(settings));
    assert.deepEqual(stored, settings, "Bridge profiles, token and display preferences survive reload");
  }
  await update(target, { fetchImpl });
  await reloadAndVerify("2.0.0");
  await rollback(target);
  await reloadAndVerify(originalVersion);
  console.log("PASS: real Chrome keeps extension ID, Bridge settings, token and preferences through fixed-directory update and rollback");
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
