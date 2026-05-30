/**
 * 标签页定位：固定目标 tab + tabId 解析 + 新标签策略。
 * 目标 tabId 存 chrome.storage.session（随 SW 休眠存活、浏览器重启清空）；
 * newTabPolicy 存 chrome.storage.local（持久设置）。
 */

export type NewTabPolicy = "stay" | "follow";

async function getTargetId(): Promise<number | null> {
  const { targetTabId } = await chrome.storage.session.get("targetTabId");
  return typeof targetTabId === "number" ? targetTabId : null;
}

async function setTargetId(id: number | null): Promise<void> {
  if (id === null) await chrome.storage.session.remove("targetTabId");
  else await chrome.storage.session.set({ targetTabId: id });
}

export async function getNewTabPolicy(): Promise<NewTabPolicy> {
  const { newTabPolicy } = await chrome.storage.local.get("newTabPolicy");
  return newTabPolicy === "follow" ? "follow" : "stay";
}

async function tabExists(id: number): Promise<boolean> {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

/** 单次调用的目标 tab：显式 tabId > 固定目标(存活) > 当前激活。 */
export async function resolveTabId(explicit?: number): Promise<number> {
  if (typeof explicit === "number") {
    if (await tabExists(explicit)) return explicit;
    throw new Error(`Tab ${explicit} 不存在（可能已关闭）`);
  }
  const target = await getTargetId();
  if (target !== null) {
    if (await tabExists(target)) return target;
    await setTargetId(null); // 目标已关，清除
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error("没有可用的激活标签页");
  return active.id;
}

export async function listTabs() {
  const target = await getTargetId();
  const tabs = await chrome.tabs.query({});
  return {
    target,
    policy: await getNewTabPolicy(),
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: t.title,
      url: t.url,
      active: t.active,
      isTarget: t.id === target,
      openedByTarget: target !== null && t.openerTabId === target,
    })),
  };
}

export async function setTargetTab(tabId: number) {
  if (!(await tabExists(tabId))) throw new Error(`Tab ${tabId} 不存在`);
  await setTargetId(tabId);
  const t = await chrome.tabs.get(tabId);
  return { ok: true, target: tabId, title: t.title, url: t.url };
}

export async function getTargetTab() {
  const target = await getTargetId();
  if (target === null) return { target: null, mode: "follow-active" as const };
  if (!(await tabExists(target))) {
    await setTargetId(null);
    return { target: null, mode: "follow-active" as const, note: "原目标已关闭，已回退到跟随激活" };
  }
  const t = await chrome.tabs.get(target);
  return { target, mode: "pinned" as const, title: t.title, url: t.url, active: t.active };
}

export async function clearTargetTab() {
  await setTargetId(null);
  return { ok: true, mode: "follow-active" as const };
}

/** 在 SW 顶层注册一次：新标签按策略处理、目标关闭则清除。 */
export function registerTabListeners() {
  chrome.tabs.onCreated.addListener(async (tab) => {
    if (typeof tab.id !== "number" || typeof tab.openerTabId !== "number") return;
    const target = await getTargetId();
    if (target === null || tab.openerTabId !== target) return;
    if ((await getNewTabPolicy()) === "follow") {
      await setTargetId(tab.id); // 自动跟随到目标页打开的新标签
    }
    // stay 策略：不动目标；list_tabs 会用 openedByTarget 标记它供 agent 决策
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if ((await getTargetId()) === tabId) await setTargetId(null);
  });
}
