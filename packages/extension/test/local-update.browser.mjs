// Tests the actual source in a tiny unpacked extension, without a release build.
// Uses an isolated Chromium profile; never changes the user's installed extension.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createZip } from "../../../scripts/release/updater-package.mjs";
import { update, rollback } from "../../../scripts/update/update-extension.mjs";

const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || "playwright");
const source = await readFile(new URL("../src/background/local-update.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const alarmName = "bridgelens-local-update";
const files = version => [
  { name: "manifest.json", data: JSON.stringify({ manifest_version: 3, name: "AgentBridgeLens", version,
    permissions: ["alarms", "storage"], background: { service_worker: "worker.js", type: "module" },
    action: { default_popup: "popup.html" } }) },
  { name: "worker.js", data: `import { startLocalUpdateChecks } from './local-update.js';
    globalThis.busy = false;
    startLocalUpdateChecks(() => globalThis.busy);
    chrome.runtime.onInstalled.addListener(() => {});` },
  { name: "local-update.js", data: outputText },
  { name: "popup.html", data: "<!doctype html><title>Local updater test</title>" },
];
const root = await mkdtemp(join(tmpdir(), "abl-local-update-browser-"));
const target = join(root, "extension");
const other = join(root, "unrelated-extension");
async function install(directory, version) {
  await mkdir(directory);
  for (const file of files(version)) await writeFile(join(directory, file.name), file.data);
}
let context;
try {
  await install(target, "1.0.0");
  await install(other, "1.0.0");
  context = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium",
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${target},${other}`, `--load-extension=${target},${other}`],
  });
  console.log(`Browser: ${context.browser().version()}`);
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const entries = await manager.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({}, resolve)));
  const id = entries.find(entry => entry.path === target).id;
  const otherId = entries.find(entry => entry.path === other).id;
  let page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const settings = { bridgeProfiles: [{ id: "remote", host: "192.0.2.10", port: 19222, token: "kept-token" }], bridgeConsent: false, activityToastEnabled: false };
  await page.evaluate(settings => chrome.storage.local.set(settings), settings);
  const alarm = await page.evaluate(name => chrome.alarms.get(name), alarmName);
  assert.equal(alarm?.periodInMinutes, 1);
  console.log("PASS: one-minute alarm registered without any Bridge connection");

  const zip = createZip(files("1.1.0")), name = "agentbridgelens-extension-1.1.0.zip";
  const fetchImpl = async url => {
    if (url.endsWith("/latest")) return new Response(JSON.stringify({ tag_name: "extension-v1.1.0", assets: [{ name }, { name: `${name}.sha256` }] }));
    if (url.endsWith(".sha256")) return new Response(`${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
    return new Response(zip);
  };
  await update(target, { fetchImpl });
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), "1.0.0", "disk replacement does not itself reload Chrome");
  async function waitForVersion(version) {
    const deadline = Date.now() + 90000;
    while (true) {
      const ready = await manager.evaluate(({ id, version }) => new Promise(resolve => {
        chrome.developerPrivate.getExtensionsInfo({}, entries => resolve(entries.some(entry => entry.id === id && entry.version === version && entry.state === "ENABLED")));
      }), { id, version });
      if (ready) break;
      assert.ok(Date.now() < deadline, `one-minute alarm did not activate ${version}`);
      await manager.waitForTimeout(500);
    }
    await page.close();
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), version);
    assert.deepEqual(await page.evaluate(keys => chrome.storage.local.get(keys), Object.keys(settings)), settings);
    const otherVersion = await manager.evaluate(id => new Promise(resolve => {
      chrome.developerPrivate.getExtensionsInfo({}, entries => resolve(entries.find(entry => entry.id === id)?.version));
    }), otherId);
    assert.equal(otherVersion, "1.0.0", "another installation directory remains untouched");
  }
  console.log(`Waiting for the real one-minute alarm (due in ~${Math.ceil((alarm.scheduledTime - Date.now()) / 1000)}s)…`);
  await waitForVersion("1.1.0");
  console.log("PASS: actual updater directory switch automatically activates 1.1.0; same ID/settings, unrelated extension unchanged");

  const worker = context.serviceWorkers().find(worker => new URL(worker.url()).host === id);
  assert.ok(worker);
  await worker.evaluate(() => { globalThis.busy = true; });
  await rollback(target);
  // Bring one alarm forward to verify that active work postpones the reload.
  await page.evaluate(name => chrome.alarms.create(name, { when: Date.now() + 1000, periodInMinutes: 1 }), alarmName);
  await manager.waitForTimeout(3500);
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), "1.1.0");
  await worker.evaluate(() => { globalThis.busy = false; });
  console.log("PASS: active task postpones reload; waiting for the next minute to activate rollback…");
  await waitForVersion("1.0.0");
  console.log("PASS: rollback automatically activates at the next minute; settings retained, no Bridge required");
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
