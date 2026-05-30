import type {
  BridgeRequest,
  BridgeResponse,
  ContentRequest,
  ContentResponse,
} from "../shared/protocol";
import { getBridgeConfig } from "../shared/config";

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
    const request = JSON.parse(event.data as string) as BridgeRequest;
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

async function handleToolCall(request: BridgeRequest): Promise<unknown> {
  const { tool, params } = request;
  const tab = await getActiveTab();

  switch (tool) {
    case "capture_screenshot": {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      return { dataUrl };
    }

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
  }
});

connect();
