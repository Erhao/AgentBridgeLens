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
  // Two real Chrome windows: broadcasts and startup snapshots must stay scoped.
  const firstWindowId = tabs.find((tab) => tab.id === aId).windowId;
  const nextPage = context.waitForEvent("page");
  const secondWindow = await worker.evaluate((url) => chrome.windows.create({ url, focused: false }), `${base}/a`);
  const c = await nextPage; await c.waitForLoadState();
  const cId = secondWindow.tabs[0].id;
  const dPage = context.waitForEvent("page");
  await worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId: secondWindow.id, url: `${base}/b` });
  const d = await dPage; await d.waitForLoadState();
  const windowOneWork = call("replay_actions", { tabId: bId, actions: Array.from({ length: 32 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.waitFor();
  await b.locator("#bridgelens-activity-toast").waitFor();
  await c.waitForTimeout(150);
  assert.equal(await c.locator("#bridgelens-activity-toast").count(), 0, "unrelated window does not show another window's action");
  assert.equal(await d.locator("#bridgelens-activity-toast").count(), 0);
  await c.reload();
  await c.waitForTimeout(150);
  assert.equal(await c.locator("#bridgelens-activity-toast").count(), 0, "initial get-activities snapshot is also window scoped");
  const fPage = context.waitForEvent("page");
  await worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId: firstWindowId, url: `${base}/a` });
  const f = await fPage; await f.waitForLoadState();
  await f.locator("#bridgelens-activity-toast").waitFor();
  const windowTwoWork = call("replay_actions", { tabId: cId, actions: Array.from({ length: 32 }, () => ({ type: "scroll", x: 0, y: 0 })) }, client2);
  await c.locator("#bridgelens-activity-toast").waitFor();
  assert.ok((await c.locator("#bridgelens-activity-toast .body").allTextContents()).every((text) => text.includes("第二 Bridge")));
  assert.ok((await toast.locator(".body").allTextContents()).every((text) => text.includes("测试 Bridge")));
  const overview = await context.newPage();
  await overview.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await overview.waitForFunction(() => {
    const text = document.querySelector("#bl-activity").textContent;
    return text.includes("测试 Bridge") && text.includes("第二 Bridge");
  });
  await overview.close();
  await a.bringToFront();
  await toast.locator(".card").first().hover();
  await a.mouse.move(0, 0);
  await worker.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: aId, windowId: secondWindow.id });
  await a.waitForFunction(() => {
    const cards = [...(document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelectorAll(".body") ?? [])];
    return cards.length > 0 && cards.every((card) => card.textContent.includes("第二 Bridge"));
  });
  assert.equal(await toast.locator('[data-pinned="true"]').count(), 0, "moving a viewer drops pins from the old window");
  await worker.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: bId, windowId: secondWindow.id });
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelectorAll(".card").length === 2);
  await f.locator("#bridgelens-activity-toast").waitFor({ state: "detached" });
  await worker.evaluate(({ ids, windowId }) => chrome.tabs.move(ids, { windowId, index: -1 }), { ids: [aId, bId], windowId: firstWindowId });
  await Promise.all([windowOneWork, windowTwoWork]);
  await worker.evaluate((id) => chrome.windows.remove(id), secondWindow.id);
  await f.close();
  await toast.waitFor({ state: "detached", timeout: 4000 });
  await a.bringToFront();

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
  const secondProgress = toast.locator(`[data-activity-id="${secondId}"] .progress`);
  assert.equal(await secondProgress.isVisible(), true, "completed cards show a countdown bar");
  const beforeProgress = await secondProgress.locator(".progress-fill").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  await a.waitForTimeout(400);
  const afterProgress = await secondProgress.locator(".progress-fill").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  assert.ok(afterProgress < beforeProgress, "countdown bar shrinks as time elapses");
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
  const rapidText = await toast.locator(".technical pre").allTextContents();
  assert.match(rapidText[0], /工具：get_page_info/);
  assert.match(rapidText[1], /工具：get_performance_metrics/);
  assert.match(rapidText[2], /工具：get_errors/);
  await toast.waitFor({ state: "detached", timeout: 2000 });

  await call("get_page_info", { tabId: aId });
  await toast.waitFor();
  const pinnedId = await toast.locator(".card").first().getAttribute("data-activity-id");
  const pinnedCard = toast.locator(`[data-activity-id="${pinnedId}"]`);
  await pinnedCard.hover();
  await a.waitForFunction((id) => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelector(`[data-activity-id="${id}"]`)?.dataset.pinned === "true", pinnedId);
  assert.equal(await pinnedCard.locator(".progress").isVisible(), false, "hover hides the progress bar");
  await a.mouse.move(0, 0);
  await a.waitForTimeout(1000);
  assert.equal(await pinnedCard.count(), 1, "moving away never restarts a pinned countdown");
  await call("get_errors", { tabId: aId }, client2);
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.querySelectorAll(".card").length === 2);
  if (process.env.ABL_PINNED_SCREENSHOT) await a.screenshot({ path: process.env.ABL_PINNED_SCREENSHOT });
  await a.waitForTimeout(1000);
  assert.equal(await toast.locator(".card").count(), 1, "other cards expire independently of pinned cards");
  await call("capture_screenshot", { tabId: aId });
  await pinnedCard.waitFor();
  assert.equal(await pinnedCard.getAttribute("data-pinned"), "true", "screenshot suppression preserves pinned state");
  await pinnedCard.locator(".card-close").click();
  await a.mouse.move(0, 0);
  await pinnedCard.waitFor({ state: "detached" });
  assert.notEqual(await worker.evaluate(async () => (await chrome.storage.local.get("activityToastEnabled")).activityToastEnabled), false, "closing one card does not disable the overlay");
  await toast.waitFor({ state: "detached", timeout: 2000 });
  const dismissRunning = call("replay_actions", { tabId: bId, actions: Array.from({ length: 8 }, () => ({ type: "scroll", x: 0, y: 0 })) });
  await toast.waitFor();
  const dismissedId = await toast.locator(".card").first().getAttribute("data-activity-id");
  await toast.locator(".card-close").first().click();
  await a.mouse.move(0, 0);
  await dismissRunning;
  await a.waitForTimeout(150);
  assert.equal(await toast.locator(`[data-activity-id="${dismissedId}"]`).count(), 0, "dismissed running calls do not reappear when completed");

  const scriptInfo = await call("execute_js", {
    tabId: aId,
    code: '(() => { const buttons = [...document.querySelectorAll("button")]; return {activitySummary:`找到 ${buttons.length} 个按钮，其中 ${buttons.filter(b => b.disabled).length} 个不可用`, elementCount:buttons.length, token:"private-result-value"}; })()',
    activity: "统计页面按钮数量，确认提交入口是否存在",
  });
  assert.equal(scriptInfo.value.elementCount, 1);
  await a.waitForFunction(() => {
    const text = document.querySelector("#bridgelens-activity-toast")?.shadowRoot.textContent ?? "";
    return text.includes("AI 说明：统计页面按钮数量") && text.includes("结果：找到 1 个按钮，其中 0 个不可用");
  });
  if (process.env.ABL_ACTIVITY_DETAIL_SCREENSHOT) await a.screenshot({ path: process.env.ABL_ACTIVITY_DETAIL_SCREENSHOT });
  assert.ok(!(await toastText()).includes("private-result-value"));
  assert.ok(!(await toastText()).includes("工具："), "technical tool names are collapsed by default");
  assert.match(await toast.locator(".technical pre").last().textContent(), /execute_js/);
  await a.mouse.move(0, 0);
  await toast.waitFor({ state: "detached", timeout: 2500 });

  await call("execute_js", { tabId: aId, code: '({unknown:"private-legacy-result"})' });
  await a.waitForFunction(() => document.querySelector("#bridgelens-activity-toast")?.shadowRoot.textContent.includes("脚本执行完成，未提供结果说明"));
  assert.ok(!(await toastText()).includes("private-legacy-result"));
  assert.ok(!(await toastText()).includes("内容未展开"));
  await toast.waitFor({ state: "detached", timeout: 2500 });

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
  assert.match(await toastText(), /回放指定的页面操作序列/, "concurrent completed calls do not hide running work");
  await a.reload();
  await toast.waitFor();
  assert.match(await toastText(), /回放指定的页面操作序列/, "reloaded pages recover active work");
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
  await toast.locator(".card").first().hover();
  await toast.locator(".header button").click();
  await a.mouse.move(0, 0);
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
  console.log("PASS: human-readable action titles, optional AI description, local outcome summaries, collapsed technical details, multiple-window isolation, scoped startup snapshots, viewer/target movement, countdown progress, permanent hover pinning, independent dismissal, pinned screenshot recovery, automatic script recovery after actual extension reload without page refresh, preserved page state, default/custom retention, independent stacked cards, creation order, rapid completions, per-bridge color customization without reconnect, automatic running/completed/failed display without opening panel, background target metadata, concurrent work, page reload, timed hide, clean screenshots, global close, independent settings, DOM exclusion and consent revoke");
} finally {
  await context?.close();
  for (const socket of ws.clients) socket.terminate();
  for (const socket of ws2.clients) socket.terminate();
  await new Promise((resolve) => ws2.close(resolve));
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
