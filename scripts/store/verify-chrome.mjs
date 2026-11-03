// Run after pnpm zip. Install Playwright separately, then set ABL_PLAYWRIGHT_MODULE
// to its index.mjs if it is not resolvable from this repository. Uses an isolated
// browser profile and loopback-only test servers; never opens a personal profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || "playwright");
const require = createRequire(resolve(root, "packages/bridge/package.json"));
const { WebSocketServer } = require("ws");
const output = resolve(root, "release/chrome-store");
await mkdir(output, { recursive: true });
const fixture = await readFile(new URL("./verification-page.html", import.meta.url), "utf8");
const http = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fixture);
}).listen(0, "127.0.0.1");
await once(http, "listening");
const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(ws, "listening");
let connections = 0;
let client;
const pending = new Map();
ws.on("connection", (socket) => {
  connections++;
  client = socket;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    pending.get(message.id)?.(message);
  });
});
const call = async (tool, params = {}) => {
  const id = crypto.randomUUID();
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${tool}`)); }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
  client.send(JSON.stringify({ id, tool, params }));
  return response;
};
const waitUntil = async (condition) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition did not become true");
};

let context;
const checks = [];
try {
  const extension = resolve(root, "packages/extension/dist");
  context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    viewport: { width: 1280, height: 800 },
    args: ["--window-size=1280,887", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await settings.locator("#bl-conn").evaluate((element) => { element.open = true; });
  await settings.locator("#bl-port").fill(String(ws.address().port));
  await settings.locator("#bl-save").click();
  await settings.waitForTimeout(700);
  assert.equal(connections, 0, "Must not connect before consent");
  checks.push("No Bridge connection before explicit consent");

  await settings.locator("#bl-consent").check();
  await settings.locator("#bl-apply-consent").click();
  await waitUntil(() => connections === 1);
  checks.push("Explicit consent establishes a Bridge connection");

  const privacy = await context.newPage();
  await privacy.goto(`chrome-extension://${extensionId}/privacy.html`);
  assert.match(await privacy.title(), /Privacy Policy/);
  await privacy.close();
  checks.push("Packaged privacy policy loads");

  const page = await context.newPage();
  const browserSession = await context.newCDPSession(page);
  const { windowId } = await browserSession.send("Browser.getWindowForTarget");
  await browserSession.send("Browser.setWindowBounds", { windowId, bounds: { width: 1280, height: 887 } });
  await browserSession.detach();
  const url = `http://127.0.0.1:${http.address().port}/`;
  await page.goto(url);
  await waitUntil(async () => (await call("list_tabs")).tabs.some((tab) => tab.url === url));
  const tabId = (await call("list_tabs")).tabs.find((tab) => tab.url === url).tabId;
  assert.equal(typeof tabId, "number");
  await call("set_target_tab", { tabId });
  const info = await call("get_page_info", { tabId });
  assert.equal(info.title, "AgentBridgeLens verification page");
  const element = await call("inspect_element", { tabId, selector: "h1" });
  assert.match(element.textContent, /Browser debugging/);
  await call("get_dom_snapshot", { tabId });
  checks.push("Target selection, page information, DOM snapshot, element inspection");

  const result = await call("execute_js", { tabId, code: "document.title" });
  assert.equal(result.value, info.title);
  assert.equal(result.viaCdp, true);
  const invalid = await call("execute_js", { tabId, code: "throw new Error('verification error')" });
  assert.match(invalid.error, /verification error/);
  // Playwright itself is a debugger client. Check that this extension's
  // session was detached without mistaking Playwright's session for its own.
  const detached = await worker.evaluate(async (tabId) => {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" });
      return false;
    } catch {
      return true;
    }
  }, tabId);
  assert.equal(detached, true);
  checks.push("Debugger API execution, error propagation and debugger detach");

  await call("start_cdp_network", { tabId });
  await page.reload();
  const network = await call("get_cdp_network", { tabId });
  assert.ok(network.requests.some((request) => request.url === url));
  await call("stop_cdp_network", { tabId });
  checks.push("Detailed network capture and stop");

  await call("mark_elements", { tabId, selectors: [".preview"], label: "Layout verified", color: "#2563eb" });
  // Background-tab CDP capture uses the exact page viewport; the foreground
  // capture API can differ by browser frame dimensions in headless Chrome.
  await settings.bringToFront();
  const screenshot = await call("capture_screenshot", { tabId });
  assert.ok(screenshot.dataUrl.startsWith("data:image/png;base64,"));
  const png = Buffer.from(screenshot.dataUrl.split(",")[1], "base64");
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 800);
  await writeFile(resolve(output, "screenshot-debugging.png"), png);
  await call("clear_overlays", { tabId });
  checks.push("Real extension screenshot and visual overlays");

  await settings.close();
  const sidepanel = await context.newPage();
  await sidepanel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await sidepanel.bringToFront();
  await sidepanel.locator("#bl-status.ok").waitFor();
  assert.equal(await sidepanel.locator("#controls").count(), 1);
  await call("get_page_info", { tabId });
  await sidepanel.locator("#log li:not(.empty)").waitFor();
  await sidepanel.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sidepanel.locator("#bl-consent").uncheck();
  const closed = once(client, "close");
  await sidepanel.locator("#bl-apply-consent").click();
  await closed;
  const count = connections;
  await sidepanel.waitForTimeout(3300);
  assert.equal(connections, count, "Must not reconnect after revocation");
  await worker.evaluate(() => chrome.alarms.create("bridgelens-keepalive", { when: Date.now() + 100 }));
  await sidepanel.waitForTimeout(700);
  assert.equal(connections, count, "Alarm must respect revoked consent");
  checks.push("Consent revocation closes connection and prevents timer/alarm reconnect");

  await writeFile(resolve(output, "browser-verification.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: context.browser()?.version(),
    profile: "isolated automated test profile, not the user's connected Chrome",
    checks,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ checks, output }, null, 2));
} finally {
  await context?.close();
  for (const socket of ws.clients) socket.terminate();
  await new Promise((resolve) => ws.close(resolve));
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
