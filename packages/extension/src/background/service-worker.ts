import type {
  BridgeRequest,
  BridgeResponse,
  ContentRequest,
  ContentResponse,
} from "../shared/protocol";
import { getBridgeConfig } from "../shared/config";
import { traceElementToSource, traceStyleToSource } from "./source-tracer";
import { startCdpNetwork, stopCdpNetwork, getCdpNetwork, cdpEvaluate } from "./cdp-network";

const RECONNECT_INTERVAL = 3000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentUrl = "";

async function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }

  const { host, port, token } = await getBridgeConfig();
  // Display URL omits the token; the actual dial URL carries it as a query param.
  currentUrl = `ws://${host}:${port}`;
  const dialUrl = token ? `${currentUrl}?token=${encodeURIComponent(token)}` : currentUrl;
  ws = new WebSocket(dialUrl);

  ws.onopen = () => {
    console.log(`[BridgeLens] Connected to bridge server at ${currentUrl}`);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = async (event) => {
    const parsed = JSON.parse(event.data as string) as BridgeRequest | { t?: string };
    // 心跳 ping：仅用于保活（收到即重置 SW 空闲计时器），无需回应。
    if ((parsed as { t?: string }).t === "ping") return;
    const request = parsed as BridgeRequest;
    try {
      const result = await handleToolCall(request);
      const response: BridgeResponse = { id: request.id, result };
      ws?.send(JSON.stringify(response));
    } catch (err) {
      const response: BridgeResponse = {
        id: request.id,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      ws?.send(JSON.stringify(response));
    }
  };

  ws.onclose = () => {
    console.log("[BridgeLens] Disconnected from bridge server");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function sendToContentScript(
  tabId: number,
  tool: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const msg: ContentRequest = { type: "bridgelens-request", id, tool, params };

    const timeout = setTimeout(() => {
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
    chrome.tabs.sendMessage(tabId, msg);
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

function requestConfirmation(message: string, options: string[]): Promise<unknown> {
  return new Promise((resolve) => {
    const cid = crypto.randomUUID();
    pendingConfirms.set(cid, (choice) => resolve({ choice }));
    broadcast({ type: "bridgelens-confirm", cid, message, options });
  });
}

async function handleToolCall(request: BridgeRequest): Promise<unknown> {
  const { tool, params } = request;

  if (tool === "request_user_confirmation") {
    broadcast({ type: "bridgelens-activity", tool, ts: Date.now() });
    const options = (params.options as string[] | undefined) || ["确认", "取消"];
    return requestConfirmation(params.message as string, options);
  }

  const tab = await getActiveTab();
  broadcast({ type: "bridgelens-activity", tool, ts: Date.now() });

  switch (tool) {
    case "capture_screenshot": {
      const selector = params.selector as string | undefined;
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      if (!selector) return { dataUrl };
      const rect = (await sendToContentScript(tab.id!, "get_element_rect", {
        selector,
      })) as { x: number; y: number; width: number; height: number; error?: string };
      if (rect.error || !rect.width || !rect.height) return { dataUrl };
      return { dataUrl: await cropDataUrl(dataUrl, rect) };
    }

    case "execute_js": {
      // 先走 content script（快、无横幅）；若被页面 CSP 拦截，回退到 CDP（绕过 CSP）。
      const res = (await sendToContentScript(tab.id!, "execute_js", params)) as {
        value?: unknown;
        error?: string;
      };
      if (res?.error && /content security policy|unsafe-eval|\beval\b/i.test(res.error)) {
        return cdpEvaluate(tab.id!, params.code as string);
      }
      return res;
    }

    case "trace_element_to_source":
      return runInMainWorld(tab.id!, traceElementToSource, [params.selector]);

    case "trace_style_to_source":
      return runInMainWorld(tab.id!, traceStyleToSource, [params.selector, params.property]);

    case "start_cdp_network":
      return startCdpNetwork(tab.id!);

    case "stop_cdp_network":
      return stopCdpNetwork();

    case "get_cdp_network":
      return getCdpNetwork(params.urlPattern as string | undefined, params.status as number | undefined);

    default:
      return sendToContentScript(tab.id!, tool, params);
  }
}

function forceReconnect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeHost || changes.bridgePort || changes.bridgeToken)) {
    forceReconnect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridgelens-get-status") {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN, url: currentUrl });
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

connect();
