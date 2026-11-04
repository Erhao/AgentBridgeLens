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
let client;
const pending = new Map();
ws.on("connection", (socket) => {
  client = socket;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    pending.get(message.id)?.(message);
  });
});
async function call(tool, params = {}) {
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
  client.send(JSON.stringify({ id, tool, params }));
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
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate((port) => chrome.storage.local.set({
    bridgeProfiles: [{ id: "test", name: "测试 Bridge", host: "127.0.0.1", port, token: "", enabled: true }],
    bridgeConsent: true,
  }), ws.address().port);
  const a = await context.newPage();
  const b = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await a.goto(`${base}/a`);
  await b.goto(`${base}/b`);
  await a.bringToFront();
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const aId = tabs.find((t) => t.title === "网站 A").id;
  const bId = tabs.find((t) => t.title === "网站 B").id;
  for (let i = 0; !client && i < 100; i++) await a.waitForTimeout(50);
  assert.ok(client, "test bridge connected");
  const toast = a.locator("#bridgelens-activity-toast");
  const work = call("replay_actions", { tabId: bId, actions: Array.from({ length: 10 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.waitFor();
  assert.match(await toast.locator(".body").innerText(), /正在执行/);
  assert.match(await toast.locator(".body").innerText(), /网站 B/);
  assert.match(await toast.locator(".body").innerText(), /测试 Bridge/);
  await call("get_console_logs", { tabId: aId });
  assert.match(await toast.locator(".body").innerText(), /操作回放/, "concurrent completed calls do not hide running work");
  await a.reload();
  await toast.waitFor();
  assert.match(await toast.locator(".body").innerText(), /操作回放/, "reloaded pages recover active work");
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
  await worker.evaluate(() => chrome.storage.local.set({ bridgeConsent: false }));
  await toast.waitFor({ state: "detached" });
  console.log("PASS: automatic running/completed/failed display without opening panel, background target metadata, concurrent work, page reload, timed hide, clean screenshots, global close, independent settings, DOM exclusion and consent revoke");
} finally {
  await context?.close();
  for (const socket of ws.clients) socket.terminate();
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
