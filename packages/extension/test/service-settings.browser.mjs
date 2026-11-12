// Build first; uses the same optional Playwright/Chromium paths as activity-toast.browser.mjs.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || "playwright");
const extension = fileURLToPath(new URL("../dist", import.meta.url));
let context;
try {
  context = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium", viewport: { width: 360, height: 780 },
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ bridgeConsent: true, bridgeProfiles: [
    { id: "one", name: "开发机", host: "127.0.0.1", port: 1, token: "private-token", enabled: true, color: "#60a5fa" },
    { id: "two", name: "备用机", host: "127.0.0.1", port: 2, token: "", enabled: false, color: "#c084fc" },
  ] }));
  const page = await context.newPage();
  const url = `chrome-extension://${extensionId}/src/popup/index.html`;
  await page.goto(url);
  await page.locator('[data-service-id="two"]').waitFor();
  const first = page.locator('[data-service-id="one"]');
  const second = page.locator('[data-service-id="two"]');
  assert.match(await first.locator("summary").textContent(), /未连接 · 开发机/);
  assert.match(await second.locator("summary").textContent(), /已停用 · 备用机/);
  assert.equal(await page.locator("#bl-conn, #bl-service").count(), 0, "there is no separate service settings section");
  assert.ok(!(await page.locator("#bl-services").innerText()).includes("private-token"), "collapsed list never shows a token");
  await first.locator("summary").click();
  const name = first.locator('input[name="name"]');
  await name.fill("修改中的开发机");
  await name.focus();
  await page.waitForTimeout(2300);
  assert.equal(await name.inputValue(), "修改中的开发机", "periodic status refresh preserves drafts");
  assert.equal(await name.evaluate((el) => document.activeElement === el), true, "refresh preserves focus");
  assert.equal(await first.evaluate((el) => el.open), true);
  await first.locator('[data-action="cancel"]').click();
  await first.locator("summary").click();
  assert.equal(await name.inputValue(), "开发机", "cancel resets saved settings");
  await first.locator('input[name="host"]').fill("https://invalid-host");
  await first.locator(".bl-service-save").click();
  await first.locator(".bl-bridge-message.bad").waitFor();
  assert.match(await first.locator(".bl-bridge-message").textContent(), /Host/);
  assert.equal(await first.evaluate((el) => el.open), true, "validation error keeps editor open");
  await first.locator('input[name="host"]').fill("127.0.0.1");
  await name.fill("主工作站");
  await first.locator('input[name="color"]').fill("#22d3ee");
  await first.locator('input[name="enabled"]').uncheck();
  await first.locator(".bl-service-save").click();
  await page.waitForFunction(() => document.querySelector('[data-service-id="one"] summary').textContent.includes("已停用 · 主工作站"));
  const profiles = await worker.evaluate(async () => (await chrome.storage.local.get("bridgeProfiles")).bridgeProfiles);
  assert.deepEqual(profiles.map((profile) => profile.id), ["one", "two"], "saving does not reorder services");
  assert.equal(profiles[0].token, "private-token");
  assert.equal(profiles[0].color, "#22d3ee");
  assert.equal(profiles[1].enabled, false);
  assert.equal(await first.evaluate((el) => el.open), false);

  await page.locator("#bl-add").click();
  let draft = page.locator('#bl-services details').last();
  assert.match(await draft.locator("summary").textContent(), /待保存/);
  assert.equal(await draft.locator('input[name="name"]').evaluate((el) => document.activeElement === el), true);
  assert.equal(await draft.locator('[data-action="delete"]').isVisible(), false);
  await draft.locator('[data-action="cancel"]').click();
  assert.equal(await page.locator("#bl-services details").count(), 2);
  await page.locator("#bl-add").click();
  draft = page.locator('#bl-services details').last();
  await draft.locator('input[name="name"]').fill("新服务");
  await draft.locator('input[name="port"]').fill("19225");
  await draft.locator('input[name="enabled"]').uncheck();
  await draft.locator(".bl-service-save").click();
  await page.waitForFunction(async () => (await chrome.storage.local.get("bridgeProfiles")).bridgeProfiles.length === 3);
  await page.reload();
  await page.locator('#bl-services details').nth(2).waitFor();
  assert.match(await page.locator('#bl-services details').nth(2).locator("summary").textContent(), /已停用 · 新服务/);
  const saved = page.locator('#bl-services details').nth(2);
  await saved.locator("summary").click();
  await saved.locator('[data-action="delete"]').click();
  await page.waitForFunction(async () => (await chrome.storage.local.get("bridgeProfiles")).bridgeProfiles.length === 2);
  await page.reload();
  await page.locator('#bl-services details').nth(1).waitFor();
  await page.screenshot({ path: process.env.ABL_SERVICES_SCREENSHOT || "/tmp/abl-inline-services.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "popup fits a narrow viewport");
  await worker.evaluate(() => chrome.storage.local.set({ bridgeConsent: false }));
  await page.reload();
  await page.locator('#bl-services details').nth(1).waitFor();
  assert.equal(await page.locator('#bl-services details').count(), 2, "settings remain accessible when consent is off");
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await page.locator('#bl-services details').nth(1).waitFor();
  await page.locator('[data-service-id="one"] summary').click();
  assert.equal(await page.locator('[data-service-id="one"] input[name="host"]').isVisible(), true, "side panel uses inline settings too");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "side panel fits a narrow viewport");
  console.log("PASS: inline service settings, enabled/disabled states, token masking, draft and focus preservation during status refresh, cancel, save without reordering, add, persistence, delete, narrow popup/sidepanel, consent-off access");
} finally { await context?.close(); }
