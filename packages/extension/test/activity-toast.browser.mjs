// Build first. Supply ABL_PLAYWRIGHT_MODULE if Playwright is installed separately,
// and optionally ABL_CHROMIUM_EXECUTABLE. Uses an isolated browser profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || "playwright");
const require = createRequire(new URL("../../bridge/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>网站 ${req.url === "/b" ? "B" : "A"}</title></head><body style="background:white;margin:0"><button id="submit">提交</button></body></html>`);
}).listen(0, "127.0.0.1");
await once(server, "listening");
const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(ws, "listening");
const ws2 = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(ws2, "listening");
let client, client2;
let connections = 0;
ws2.on("connection", (socket) => {
  client2 = socket; connections++;
  socket.on("message", (raw) => { const message = JSON.parse(raw.toString()); pending.get(message.id)?.(message); });
});
const pending = new Map();
ws.on("connection", (socket) => {
  client = socket; connections++;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    pending.get(message.id)?.(message);
  });
});
async function call(tool, params = {}, socket = client) {
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${tool}`)); }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
  socket.send(JSON.stringify({ id, tool, params }));
  return promise;
}
const extension = fileURLToPath(new URL("../dist", import.meta.url));
let context;
try {
  context = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium", viewport: { width: 900, height: 700 },
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(([port, port2]) => chrome.storage.local.set({
    bridgeProfiles: [
      { id: "test", name: "测试 Bridge", host: "127.0.0.1", port, token: "", enabled: true, color: "#f97316" },
      { id: "other", name: "第二 Bridge", host: "127.0.0.1", port: port2, token: "", enabled: true, color: "#22d3ee" },
    ],
    bridgeConsent: true,
  }), [ws.address().port, ws2.address().port]);
  const a = await context.newPage();
  const b = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await a.goto(`${base}/a`);
  await b.goto(`${base}/b`);
  await a.bringToFront();
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const aId = tabs.find((t) => t.title === "网站 A").id;
  const bId = tabs.find((t) => t.title === "网站 B").id;
  for (let i = 0; (!client || !client2) && i < 100; i++) await a.waitForTimeout(50);
  assert.ok(client && client2, "both test bridges connected");
  const toast = a.locator("#bridgelens-activity-toast");
  const toastText = async () => (await toast.locator(".body").allTextContents()).join("\n");
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  assert.equal(await settings.locator("#bl-toast-seconds").inputValue(), "2", "default completion delay is 2 seconds");
  await settings.locator("#bl-toast-seconds").fill("0.8");
  await settings.locator("#bl-toast-seconds").dispatchEvent("change");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("activityToastSeconds")).activityToastSeconds === 0.8);
  await settings.close();
  await a.bringToFront();
  const longWork = call("replay_actions", { tabId: bId, actions: Array.from({ length: 12 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.locator(".card").waitFor();
  await a.waitForTimeout(100);
  await call("get_page_info", { tabId: aId }, client2);
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelectorAll(".card").length === 2);
  const ordered = await toast.locator(".body").allTextContents();
  assert.match(ordered[0], /测试 Bridge/); assert.match(ordered[1], /第二 Bridge/);
  const firstId = await toast.locator(".card").nth(0).getAttribute("data-activity-id");
  const secondId = await toast.locator(".card").nth(1).getAttribute("data-activity-id");
  const accents = await toast.locator(".card").evaluateAll((cards) => cards.map((card) => getComputedStyle(card).borderLeftColor));
  assert.deepEqual(accents, ["rgb(249, 115, 22)", "rgb(34, 211, 238)"]);
  const boxes = await toast.locator(".card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().top));
  assert.ok(boxes[0] < boxes[1], "newest card is visually below older work");
  if (process.env.ABL_TOAST_SCREENSHOT) await a.screenshot({ path: process.env.ABL_TOAST_SCREENSHOT });
  await a.waitForTimeout(400);
  assert.equal(await toast.locator(`[data-activity-id="${secondId}"]`).count(), 1, "completed card stays for its delay");
  await toast.locator(`[data-activity-id="${secondId}"]`).waitFor({ state: "detached", timeout: 2000 });
  assert.equal(await toast.locator(`[data-activity-id="${firstId}"]`).count(), 1, "another running card remains visible");
  await longWork;
  await toast.waitFor({ state: "detached", timeout: 2000 });

  // Rapid sequential completions must not overwrite cards before they expire.
  await call("get_page_info", { tabId: aId });
  await call("get_performance_metrics", { tabId: aId }, client2);
  await call("get_errors", { tabId: aId });
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelectorAll(".card").length === 3);
  const rapidText = await toast.locator(".body").allTextContents();
  assert.match(rapidText[0], /工具：get_page_info/);
  assert.match(rapidText[1], /工具：get_performance_metrics/);
  assert.match(rapidText[2], /工具：get_errors/);
  await toast.waitFor({ state: "detached", timeout: 2000 });

  const settings2 = await context.newPage();
  await settings2.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  assert.equal(await settings2.locator("#bl-toast-seconds").inputValue(), "0.8", "duration persists when reopening the popup");
  await settings2.locator("#bl-toast-seconds").fill("3");
  await settings2.locator("#bl-toast-seconds").dispatchEvent("change");
  const coloringWork = call("replay_actions", { tabId: bId, actions: Array.from({ length: 12 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.waitFor();
  await settings2.locator("#bl-conn").evaluate((el) => { el.open = true; });
  await settings2.locator("#bl-service").selectOption("test");
  await settings2.locator("#bl-color").evaluate((el) => { el.value = "#a855f7"; });
  await settings2.locator("#bl-save").click();
  await a.waitForFunction(() => {
    const card = document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelector(".card");
    return card && getComputedStyle(card).borderLeftColor === "rgb(168, 85, 247)";
  });
  await settings2.waitForFunction(() => [...document.querySelectorAll(".bl-bridge-line")].some((row) => row.textContent.includes("测试 Bridge") && getComputedStyle(row).borderLeftColor === "rgb(168, 85, 247)"));
  assert.equal(connections, 2, "customizing accents does not reconnect or abort either service");
  await coloringWork;
  await a.waitForTimeout(1000);
  assert.equal(await toast.locator(".card").count(), 1, "custom 3-second delay exceeds the old 0.8-second duration");
  await settings2.locator("#bl-toast-seconds").fill("0.1");
  await settings2.locator("#bl-toast-seconds").dispatchEvent("change");
  await toast.waitFor({ state: "detached" });
  await settings2.locator("#bl-toast-seconds").fill("2");
  await settings2.locator("#bl-toast-seconds").dispatchEvent("change");
  await settings2.close();
  await a.bringToFront();
  const work = call("replay_actions", { tabId: bId, actions: Array.from({ length: 10 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.waitFor();
  assert.match(await toastText(), /正在执行/);
  assert.match(await toastText(), /网站 B/);
  assert.match(await toastText(), /测试 Bridge/);
  await call("get_console_logs", { tabId: aId });
  assert.match(await toastText(), /操作回放/, "concurrent completed calls do not hide running work");
  await a.reload();
  await toast.waitFor();
  assert.match(await toastText(), /操作回放/, "reloaded pages recover active work");
  await work;
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.textContent.includes("已完成"));
  const failure = await call("inspect_element", { tabId: bId, selector: "#missing" });
  assert.ok(failure.error);
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.textContent.includes("执行失败"));
  await toast.waitFor({ state: "detached", timeout: 6000 });
  await call("get_page_info", { tabId: aId });
  await toast.waitFor();
  const shot = await call("capture_screenshot", { tabId: aId });
  const pixel = await a.evaluate(async (url) => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(image.width - 30, image.height - 30, 1, 1).data];
  }, shot.dataUrl);
  assert.deepEqual(pixel, [255, 255, 255, 255], "automatic toast must not appear in tool screenshots");
  await toast.waitFor();
  await toast.locator("button").click();
  await toast.waitFor({ state: "detached" });
  await call("get_page_info", { tabId: bId });
  await a.waitForTimeout(200);
  assert.equal(await toast.count(), 0, "toast close disables future automatic prompts");
  assert.equal(await b.locator("#bridgelens-activity-toast").count(), 0, "disable applies to all pages");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await popup.waitForFunction(() => !document.querySelector("#bl-toast-enabled").checked);
  assert.equal(await popup.locator("#bl-activity-enabled").isChecked(), true, "panel display is independent");
  await popup.locator("#bl-toast-enabled").check();
  await popup.close();
  await a.bringToFront();
  await call("get_dom_snapshot", { tabId: aId, selector: "html" });
  await toast.waitFor();
  const dom = await call("get_dom_snapshot", { tabId: aId, selector: "html" });
  assert.ok(!JSON.stringify(dom).includes("bridgelens-activity-toast"), "toast is excluded from DOM snapshots");
  // Reload the actual extension while leaving both web pages untouched.
  await a.evaluate(() => { window.__ablRecoveryMarker = "unsaved-page-state"; });
  const oldClient = client;
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const reloadError = await manager.evaluate((id) => new Promise((done) => {
    chrome.developerPrivate.reload(id, { failQuietly: true }, () => done(chrome.runtime.lastError?.message));
  }), extensionId);
  assert.equal(reloadError, undefined);
  const recoveryPopup = await context.newPage();
  await recoveryPopup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  for (let i = 0; (client === oldClient || client.readyState !== 1) && i < 100; i++) await a.waitForTimeout(50);
  assert.notEqual(client, oldClient, "bridge reconnects after extension reload");
  await a.bringToFront();
  const recoveredShot = await call("capture_screenshot", { tabId: aId });
  const recoveredPixel = await a.evaluate(async (url) => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(image.width - 30, image.height - 30, 1, 1).data];
  }, recoveredShot.dataUrl);
  assert.deepEqual(recoveredPixel, [255, 255, 255, 255], "auto-recovery must not leak the overlay into screenshots");
  const recovered = await call("get_page_info", { tabId: aId });
  assert.equal(recovered.title, "网站 A", "content tools recover without refreshing the page");
  await toast.waitFor();
  assert.equal(await toast.count(), 1, "orphaned old toasts are removed during recovery");
  assert.equal(await a.evaluate(() => window.__ablRecoveryMarker), "unsaved-page-state", "recovery never navigates or refreshes the page");
  assert.equal(await a.locator("#bridgelens-reload-hint").count(), 0, "healthy recovered pages do not ask for a refresh");
  await recoveryPopup.evaluate(() => chrome.storage.local.set({ bridgeConsent: false }));
  await toast.waitFor({ state: "detached" });
  console.log("PASS: automatic script recovery after actual extension reload without page refresh, preserved page state, default/custom retention, independent stacked cards, creation order, rapid completions, per-bridge color customization without reconnect, automatic running/completed/failed display without opening panel, background target metadata, concurrent work, page reload, timed hide, clean screenshots, global close, independent settings, DOM exclusion and consent revoke");
} finally {
  await context?.close();
  for (const socket of ws.clients) socket.terminate();
  for (const socket of ws2.clients) socket.terminate();
  await new Promise((resolve) => ws2.close(resolve));
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
