import type {
  BridgeRequest,
  ContentRequest,
  ContentResponse,
} from "../shared/protocol";
import { describeActivity, activitiesForWindow, type Activity } from "../shared/activity";
import { getBridgeProfiles, BRIDGE_COLORS } from "../shared/config";
import { ContentConnection } from "./content-connection";
import { BridgeConnections, type BridgeSource } from "./bridge-connections";
import { traceElementToSource, traceStyleToSource } from "./source-tracer";
import {
  startCdpNetwork,
  stopCdpNetwork,
  getCdpNetwork,
  cdpEvaluate,
  cdpScreenshot,
} from "./cdp-network";
import {
  resolveTabId,
  listTabs,
  setTargetTab,
  getTargetTab,
  clearTargetTab,
  registerTabListeners,
} from "./tabs";

const connections = new BridgeConnections(handleToolCall);
const contentConnection = new ContentConnection();
chrome.tabs.onRemoved.addListener((tabId) => contentConnection.forget(tabId));
chrome.tabs.onAttached.addListener((tabId, info) => {
  // Running work follows its target tab; completed history belongs to where it happened.
  for (const activity of activeActivities.values()) if (activity.tabId === tabId) activity.windowId = info.newWindowId;
  // Also refresh a viewer tab moved to another window, including pinned cards.
  publishActivities();
});
let configRevision = 0;
let bridgeColors = new Map<string, string>();
async function connect() {
  const revision = ++configRevision;
  const [profiles, { bridgeConsent }] = await Promise.all([
    getBridgeProfiles(), chrome.storage.local.get("bridgeConsent"),
  ]);
  if (revision === configRevision) {
    bridgeColors = new Map(profiles.map((profile) => [profile.id, profile.color ?? BRIDGE_COLORS[0]]));
    connections.update(profiles, bridgeConsent === true);
    for (const activity of [...activeActivities.values(), ...recentActivities]) {
      if (activity.bridgeId && bridgeColors.has(activity.bridgeId)) activity.bridgeColor = bridgeColors.get(activity.bridgeId);
    }
    publishActivities();
  }
}

/** 截图：激活 tab 用 captureVisibleTab（快、无横幅）；后台 tab 用 CDP（可截后台）。 */
async function screenshot(tabId: number, selector?: string): Promise<{ dataUrl: string }> {
  await contentConnection.ensure(tabId).catch(() => { /* CDP still supports some restricted pages */ });
  const token = crypto.randomUUID();
  const notify = (hide: boolean) => chrome.tabs.sendMessage(tabId, {
    type: "bridgelens-activity-capture", token, hide,
  }, { frameId: 0 }).catch(() => { /* restricted page or old content script */ });
  await notify(true);
  try {
    return await captureScreenshot(tabId, selector);
  } finally {
    await notify(false);
  }
}

async function captureScreenshot(tabId: number, selector?: string): Promise<{ dataUrl: string }> {
  const tab = await chrome.tabs.get(tabId);
  const full = tab.active
    ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    : await cdpScreenshot(tabId);
  if (!selector) return { dataUrl: full };
  const rect = (await sendToContentScript(tabId, "get_element_rect", { selector })) as {
    x: number;
    y: number;
    width: number;
    height: number;
    error?: string;
  };
  if (rect.error || !rect.width || !rect.height) return { dataUrl: full };
  return { dataUrl: await cropDataUrl(full, rect) };
}

async function sendToContentScript(
  tabId: number,
  tool: string,
  params: Record<string, unknown>
): Promise<unknown> {
  await contentConnection.ensure(tabId);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const msg: ContentRequest = { type: "bridgelens-request", id, tool, params };

    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Content script timeout for '${tool}'`));
    }, 15_000);

    const listener = (
      message: ContentResponse,
      sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void
    ) => {
      if (message.type !== "bridgelens-response" || message.id !== id) return;
      if (sender.tab?.id !== tabId) return;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    void chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch((error: unknown) => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      reject(error);
    });
  });
}

async function runInMainWorld<T>(
  tabId: number,
  func: (...args: never[]) => T,
  args: unknown[]
): Promise<T> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: func as (...args: unknown[]) => T,
    args: args as never[],
  });
  return injection.result as T;
}

async function cropDataUrl(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const sx = Math.round(rect.x);
  const sy = Math.round(rect.y);
  const w = Math.max(1, Math.min(Math.round(rect.width), bitmap.width - sx));
  const h = Math.max(1, Math.min(Math.round(rect.height), bitmap.height - sy));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await outBlob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

/** 向 Side Panel 等扩展页面广播消息（无接收方时静默忽略）。 */
function broadcast(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no side panel open */
  });
}

const pendingConfirms = new Map<string, (choice: string) => void>();

function requestConfirmation(message: string, options: string[], source: BridgeSource): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cid = crypto.randomUUID();
    const finish = (choice?: string) => {
      clearTimeout(timeout);
      source.signal.removeEventListener("abort", abort);
      pendingConfirms.delete(cid);
      broadcast({ type: "bridgelens-confirm-dismiss", cid });
      if (choice !== undefined) resolve({ choice });
      else reject(new Error("Confirmation expired or bridge disconnected"));
    };
    const abort = () => finish();
    const timeout = setTimeout(abort, 110_000);
    source.signal.addEventListener("abort", abort, { once: true });
    if (source.signal.aborted) { abort(); return; }
    pendingConfirms.set(cid, finish);
    broadcast({ type: "bridgelens-confirm", cid, message, options, bridgeName: source.name, bridgeUrl: source.url });
  });
}

const activeActivities = new Map<string, Activity>();
let lastActivity: Activity | undefined;
let activitySequence = 0;
const recentActivities: Activity[] = [];
let activityRevision = Date.now();
function activitySnapshot() {
  // Keep completion metadata for the maximum configurable delay; bound bursts.
  while (recentActivities.length && (recentActivities.length > 100 || (recentActivities[0].finishedAt ?? 0) < Date.now() - 300000)) recentActivities.shift();
  return { active: [...activeActivities.values()], last: lastActivity, recent: [...recentActivities], revision: activityRevision };
}
function publishActivities() {
  activityRevision = Math.max(Date.now(), activityRevision + 1);
  const revision = activityRevision;
  // Clone now so in-flight query callbacks cannot mutate an older snapshot.
  const message = structuredClone({ type: "bridgelens-activities", ...activitySnapshot() });
  broadcast(message);
  // Background-target work remains visible while switching tabs in that window.
  // Other windows get an empty snapshot rather than unrelated activity metadata.
  void chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).then((tabs) => {
    if (revision !== activityRevision) return;
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      const scoped = { type: "bridgelens-activities", ...activitiesForWindow(message, tab.windowId) };
      const hasActivity = scoped.active.length > 0 || (scoped.recent?.length ?? 0) > 0 || !!scoped.last;
      const delivery = hasActivity ? contentConnection.sendActivity(tab.id, scoped)
        : chrome.tabs.sendMessage(tab.id, scoped, { frameId: 0 });
      void delivery.catch(() => { /* restricted pages / content script not ready */ });
    }
  }).catch(() => {});
}

async function handleToolCall(request: BridgeRequest, source: BridgeSource): Promise<unknown> {
  const activity: Activity = {
    id: crypto.randomUUID(), tool: request.tool, ...describeActivity(request.tool, request.params),
    bridgeName: source.name, bridgeId: source.id, bridgeColor: bridgeColors.get(source.id) ?? BRIDGE_COLORS[0],
    sequence: ++activitySequence, state: "running", startedAt: Date.now(),
  };
  activeActivities.set(activity.id, activity);
  publishActivities();
  try {
    const result = await executeToolCall(request, source, activity);
    activity.state = result && typeof result === "object" && "error" in result ? "failed" : "completed";
    return result;
  } catch (error) {
    activity.state = "failed";
    throw error;
  } finally {
    activity.finishedAt = Date.now();
    activeActivities.delete(activity.id);
    lastActivity = activity;
    recentActivities.push(activity);
    publishActivities();
  }
}

async function executeToolCall(request: BridgeRequest, source: BridgeSource, activity: Activity): Promise<unknown> {
  const { tool, params } = request;

  // —— 不针对具体页面的管理类工具 ——
  switch (tool) {
    case "list_tabs":
      return listTabs();
    case "set_target_tab":
      return setTargetTab(params.tabId as number);
    case "get_target_tab":
      return getTargetTab();
    case "clear_target_tab":
      return clearTargetTab(params.tabId as number | undefined);
    case "request_user_confirmation": {
      const options = (params.options as string[] | undefined) || ["确认", "取消"];
      return requestConfirmation(params.message as string, options, source);
    }
  }

  // —— 页面类工具：解析目标 tab（显式 tabId > 固定目标 > 激活）——
  const tabId = await resolveTabId(params.tabId as number | undefined);

  activity.tabId = tabId;
  // Metadata lookup must never prevent a tool from running.
  try {
    const tab = await chrome.tabs.get(tabId);
    activity.windowId = tab.windowId;
    activity.page = tab.title;
    if (tab.url) activity.site = new URL(tab.url).origin;
  } catch { /* tab may have closed */ }
  publishActivities();

  switch (tool) {
    case "capture_screenshot":
      return screenshot(tabId, params.selector as string | undefined);

    // MV3 permits externally supplied debugging expressions through the Debugger
    // API. Never evaluate bridge-supplied strings inside extension content scripts.
    case "execute_js":
      return cdpEvaluate(tabId, params.code as string);

    case "trace_element_to_source":
      return runInMainWorld(tabId, traceElementToSource, [params.selector]);

    case "trace_style_to_source":
      return runInMainWorld(tabId, traceStyleToSource, [params.selector, params.property]);

    case "start_cdp_network":
      return startCdpNetwork(tabId);

    case "stop_cdp_network":
      return stopCdpNetwork(tabId);

    case "get_cdp_network":
      return getCdpNetwork(tabId, params.urlPattern as string | undefined, params.status as number | undefined);

    default:
      return sendToContentScript(tabId, tool, params);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeProfiles || changes.bridgeHost || changes.bridgePort || changes.bridgeToken || changes.bridgeConsent)) {
    void connect();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridgelens-get-activities") {
    const snapshot = activitySnapshot();
    // Extension popup/side panel keep the global log; webpage startup is scoped too.
    const fromWebpage = sender.tab && /^https?:\/\//i.test(sender.url ?? sender.tab.url ?? "");
    sendResponse(fromWebpage ? activitiesForWindow(snapshot, sender.tab!.windowId) : snapshot);
  } else if (message?.type === "bridgelens-get-status") {
    const bridges = connections.status().map((bridge) => ({ ...bridge, color: bridgeColors.get(bridge.id) ?? BRIDGE_COLORS[0] }));
    sendResponse({ connected: bridges.some((bridge) => bridge.connected), bridges });
  } else if (message?.type === "bridgelens-confirm-result") {
    const fn = pendingConfirms.get(message.cid);
    if (fn) {
      pendingConfirms.delete(message.cid);
      fn(message.choice);
    }
  }
});

// Keepalive：MV3 Service Worker 闲置 ~30s 后会休眠，基于 setTimeout 的重连定时器会随之失效。
// chrome.alarms 即使在 SW 休眠时也能按时唤醒它；每次触发都重新执行顶层代码并尝试重连
// （connect() 在已连接时是空操作），从而保证断线后能自动恢复，无需用户手动唤醒扩展。
chrome.alarms.create("bridgelens-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridgelens-keepalive") connect();
});

// 安装/更新后自动恢复旧标签页的 content script；恢复失败时才提示刷新。
// 不导航或刷新页面，避免丢失用户未保存的输入。
// 该函数经 chrome.scripting 注入页面执行，必须自包含（仅用 DOM / location）。
function showReloadHint() {
  const ID = "bridgelens-reload-hint";
  if (document.getElementById(ID)) return;
  const bar = document.createElement("div");
  bar.id = ID;
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4a90d9;color:#fff;" +
    "font:13px/1.5 system-ui,sans-serif;padding:8px 14px;display:flex;align-items:center;gap:12px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.25);";
  const msg = document.createElement("span");
  msg.style.flex = "1";
  msg.textContent =
    "AgentBridgeLens 网页脚本未能自动恢复。请检查扩展的站点访问权限，或刷新本页后重试。";
  const reload = document.createElement("button");
  reload.textContent = "刷新";
  reload.style.cssText =
    "background:#fff;color:#2d6fd6;border:none;border-radius:5px;padding:4px 12px;cursor:pointer;font:13px system-ui;";
  reload.addEventListener("click", () => location.reload());
  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText = "background:transparent;color:#fff;border:none;cursor:pointer;font-size:15px;";
  close.addEventListener("click", () => bar.remove());
  bar.appendChild(msg);
  bar.appendChild(reload);
  bar.appendChild(close);
  document.documentElement.appendChild(bar);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    void contentConnection.ensure(t.id).catch(() => {
      void chrome.scripting.executeScript({ target: { tabId: t.id! }, func: showReloadHint }).catch(() => {
        /* 受限页面（如 web store / PDF viewer）忽略 */
      });
    });
  }
});

registerTabListeners();
connect();
