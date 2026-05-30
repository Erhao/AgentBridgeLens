/**
 * 基于 chrome.debugger（CDP）的网络监控。
 * 相比 content script 注入式捕获，CDP 能拿到更底层、更完整的数据（含响应体），
 * 且不会漏掉 content script 注入前发出的请求。代价：附加 debugger 会在标签页顶部
 * 显示「DevTools 正在调试此标签页」横幅，且与已打开的 DevTools 互斥。
 * 因此设计为**显式 start/stop**，不自动附加。
 */

interface CdpRequest {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: number;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  failed?: string;
}

const records = new Map<string, CdpRequest>();
let attachedTabId: number | null = null;

function onEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object
): void {
  if (source.tabId !== attachedTabId) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = params as any;
  if (method === "Network.requestWillBeSent") {
    records.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      startTime: p.timestamp,
    });
  } else if (method === "Network.responseReceived") {
    const r = records.get(p.requestId);
    if (r) {
      r.status = p.response.status;
      r.mimeType = p.response.mimeType;
      r.type = p.type;
    }
  } else if (method === "Network.loadingFinished") {
    const r = records.get(p.requestId);
    if (r) r.endTime = p.timestamp;
  } else if (method === "Network.loadingFailed") {
    const r = records.get(p.requestId);
    if (r) {
      r.endTime = p.timestamp;
      r.failed = p.errorText;
    }
  }
}

function onDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

export async function startCdpNetwork(tabId: number) {
  if (attachedTabId === tabId) return { status: "already-attached", tabId };
  if (attachedTabId !== null) await stopCdpNetwork();

  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;
  records.clear();
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  return { status: "attached", tabId, note: "CDP 网络监控已开启，新发出的请求会被记录。" };
}

export async function stopCdpNetwork() {
  if (attachedTabId === null) return { status: "not-attached" };
  const tabId = attachedTabId;
  chrome.debugger.onEvent.removeListener(onEvent);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
  attachedTabId = null;
  return { status: "detached", tabId };
}

export function getCdpNetwork(urlPattern?: string, status?: number) {
  let list = Array.from(records.values());
  if (urlPattern) list = list.filter((r) => r.url.includes(urlPattern));
  if (status) list = list.filter((r) => r.status === status);
  return {
    attached: attachedTabId !== null,
    count: list.length,
    requests: list.map((r) => ({
      url: r.url,
      method: r.method,
      type: r.type,
      status: r.status,
      mimeType: r.mimeType,
      failed: r.failed,
      durationMs:
        r.endTime && r.startTime ? Math.round((r.endTime - r.startTime) * 1000) : undefined,
    })),
  };
}
