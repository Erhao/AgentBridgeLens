/**
 * 基于 chrome.debugger（CDP）的能力：网络监控、execute_js 的 CSP 回退、后台 tab 截图。
 * 全部**按 tabId 并行**——支持同时跟踪多个标签页。
 * 附加 debugger 会在标签页顶部显示「DevTools 正在调试此标签页」横幅，且与已打开的 DevTools 互斥。
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

// 每个 tab 独立的网络记录；以及当前由“网络监控”持有 attach 的 tab 集合。
const records = new Map<number, Map<string, CdpRequest>>();
const networkTabs = new Set<number>();

function onEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;
  const tabRecords = records.get(tabId);
  if (!tabRecords) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = params as any;
  if (method === "Network.requestWillBeSent") {
    tabRecords.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      startTime: p.timestamp,
    });
  } else if (method === "Network.responseReceived") {
    const r = tabRecords.get(p.requestId);
    if (r) {
      r.status = p.response.status;
      r.mimeType = p.response.mimeType;
      r.type = p.type;
    }
  } else if (method === "Network.loadingFinished") {
    const r = tabRecords.get(p.requestId);
    if (r) r.endTime = p.timestamp;
  } else if (method === "Network.loadingFailed") {
    const r = tabRecords.get(p.requestId);
    if (r) {
      r.endTime = p.timestamp;
      r.failed = p.errorText;
    }
  }
}

function onDetach(source: chrome.debugger.Debuggee): void {
  const tabId = source.tabId;
  if (typeof tabId === "number") networkTabs.delete(tabId);
}

let listenersBound = false;
function ensureListeners() {
  if (listenersBound) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  listenersBound = true;
}

/** 该 tab 当前是否已被本扩展 attach（任何用途）。用于决定 attach/detach 是否复用。 */
async function isAttached(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached);
}

export async function startCdpNetwork(tabId: number) {
  ensureListeners();
  if (networkTabs.has(tabId)) return { status: "already-attached", tabId };
  if (!(await isAttached(tabId))) await chrome.debugger.attach({ tabId }, "1.3");
  networkTabs.add(tabId);
  records.set(tabId, new Map());
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  return { status: "attached", tabId, note: "CDP 网络监控已开启，新发出的请求会被记录。" };
}

export async function stopCdpNetwork(tabId: number) {
  if (!networkTabs.has(tabId)) return { status: "not-attached", tabId };
  networkTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
  return { status: "detached", tabId };
}

export function getCdpNetwork(tabId: number, urlPattern?: string, status?: number) {
  const tabRecords = records.get(tabId);
  let list = tabRecords ? Array.from(tabRecords.values()) : [];
  if (urlPattern) list = list.filter((r) => r.url.includes(urlPattern));
  if (status) list = list.filter((r) => r.status === status);
  return {
    tabId,
    attached: networkTabs.has(tabId),
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

/** 用 CDP Runtime.evaluate 执行代码（绕过页面 CSP，见 F1）。按 tabId。 */
export async function cdpEvaluate(tabId: number, code: string) {
  const reuse = await isAttached(tabId);
  if (!reuse) await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const res = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (res.exceptionDetails) {
      return {
        error: res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluation error",
        viaCdp: true,
      };
    }
    return { value: res.result?.value, viaCdp: true };
  } finally {
    if (!reuse) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* already detached */
      }
    }
  }
}

/** 截取后台 tab（CDP Page.captureScreenshot，可截不在前台的 tab）。返回 dataURL。 */
export async function cdpScreenshot(tabId: number): Promise<string> {
  const reuse = await isAttached(tabId);
  if (!reuse) await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const res = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    return `data:image/png;base64,${res.data}`;
  } finally {
    if (!reuse) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* already detached */
      }
    }
  }
}
