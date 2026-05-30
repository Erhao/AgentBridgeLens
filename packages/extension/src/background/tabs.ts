/**
 * 标签页定位：一组「固定目标」+ tabId 解析 + 每目标的新标签策略。
 * - 目标集合存 chrome.storage.session.targetTabIds（随 SW 休眠存活、浏览器重启清空）。
 * - 每目标策略存 chrome.storage.session.tabPolicies[tabId]，缺省回退全局 newTabPolicy（storage.local）。
 * - 多 tab 跟踪本就靠每次调用传 tabId；"固定目标"只是省略 tabId 时的默认值（多个时取最近活跃的那个）。
 */

export type NewTabPolicy = "stay" | "follow";

async function getTargets(): Promise<number[]> {
  const { targetTabIds } = await chrome.storage.session.get("targetTabIds");
  return Array.isArray(targetTabIds) ? targetTabIds.filter((x) => typeof x === "number") : [];
}
async function setTargets(ids: number[]): Promise<void> {
  await chrome.storage.session.set({ targetTabIds: ids });
}
async function getLastActive(): Promise<number | null> {
  const { lastActiveTabId } = await chrome.storage.session.get("lastActiveTabId");
  return typeof lastActiveTabId === "number" ? lastActiveTabId : null;
}

export async function getNewTabPolicy(): Promise<NewTabPolicy> {
  const { newTabPolicy } = await chrome.storage.local.get("newTabPolicy");
  return newTabPolicy === "follow" ? "follow" : "stay";
}
async function getTabPolicies(): Promise<Record<string, NewTabPolicy>> {
  const { tabPolicies } = await chrome.storage.session.get("tabPolicies");
  return tabPolicies && typeof tabPolicies === "object" ? tabPolicies : {};
}
async function getEffectivePolicy(tabId: number): Promise<NewTabPolicy> {
  const p = (await getTabPolicies())[String(tabId)];
  if (p === "follow" || p === "stay") return p;
  return getNewTabPolicy();
}

async function tabExists(id: number): Promise<boolean> {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

/** 清掉已关闭的目标，返回仍存活的目标集合。 */
async function liveTargets(): Promise<number[]> {
  const targets = await getTargets();
  const alive: number[] = [];
  for (const id of targets) if (await tabExists(id)) alive.push(id);
  if (alive.length !== targets.length) await setTargets(alive);
  return alive;
}

/** 单次调用的目标 tab：显式 tabId > 固定目标（多个取最近活跃的）> 当前激活。 */
export async function resolveTabId(explicit?: number): Promise<number> {
  if (typeof explicit === "number") {
    if (await tabExists(explicit)) return explicit;
    throw new Error(`Tab ${explicit} 不存在（可能已关闭）`);
  }
  const alive = await liveTargets();
  if (alive.length) {
    const la = await getLastActive();
    if (la !== null && alive.includes(la)) return la;
    return alive[alive.length - 1];
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error("没有可用的激活标签页");
  return active.id;
}

export async function listTabs() {
  const targets = await liveTargets();
  const policies = await getTabPolicies();
  const fallback = await getNewTabPolicy();
  const tabs = await chrome.tabs.query({});
  return {
    targets,
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: t.title,
      url: t.url,
      active: t.active,
      isTarget: typeof t.id === "number" && targets.includes(t.id),
      openedByTarget: typeof t.openerTabId === "number" && targets.includes(t.openerTabId),
      newTabPolicy:
        typeof t.id === "number" && targets.includes(t.id)
          ? policies[String(t.id)] ?? fallback
          : undefined,
    })),
  };
}

export async function setTargetTab(tabId: number) {
  if (!(await tabExists(tabId))) throw new Error(`Tab ${tabId} 不存在`);
  const targets = await getTargets();
  if (!targets.includes(tabId)) targets.push(tabId);
  await setTargets(targets);
  const t = await chrome.tabs.get(tabId);
  return { ok: true, targets, pinned: { tabId, title: t.title, url: t.url } };
}

export async function getTargetTab() {
  const targets = await liveTargets();
  if (targets.length === 0) return { targets: [], mode: "follow-active" as const };
  const def = await resolveTabId();
  const detail = await Promise.all(
    targets.map(async (id) => {
      const t = await chrome.tabs.get(id);
      return { tabId: id, title: t.title, url: t.url, isDefault: id === def };
    })
  );
  return { targets: detail, default: def, mode: "pinned" as const };
}

export async function clearTargetTab(tabId?: number) {
  if (typeof tabId === "number") {
    const targets = (await getTargets()).filter((x) => x !== tabId);
    await setTargets(targets);
    return { ok: true, targets };
  }
  await setTargets([]);
  return { ok: true, targets: [] };
}

/** 在 SW 顶层注册一次。 */
export function registerTabListeners() {
  chrome.tabs.onActivated.addListener((info) => {
    void chrome.storage.session.set({ lastActiveTabId: info.tabId });
  });

  chrome.tabs.onCreated.addListener(async (tab) => {
    if (typeof tab.id !== "number" || typeof tab.openerTabId !== "number") return;
    const targets = await getTargets();
    if (!targets.includes(tab.openerTabId)) return;
    if ((await getEffectivePolicy(tab.openerTabId)) === "follow") {
      if (!targets.includes(tab.id)) {
        targets.push(tab.id); // 自动把目标页打开的新标签也加入跟踪
        await setTargets(targets);
      }
    }
    // stay：不加入；list_tabs 用 openedByTarget 标记供 agent 决策
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const targets = await getTargets();
    if (targets.includes(tabId)) await setTargets(targets.filter((x) => x !== tabId));
    const tp = await getTabPolicies();
    if (tp[String(tabId)]) {
      delete tp[String(tabId)];
      await chrome.storage.session.set({ tabPolicies: tp });
    }
  });
}
