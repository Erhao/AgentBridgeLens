import { formatActivityCard, ActivityToastState, type ActivitySnapshot } from "../shared/activity";
import { toastSeconds, withBridgeColors, isBridgeColor, BRIDGE_COLORS, type BridgeProfile } from "../shared/config";

const HOST_ID = "bridgelens-activity-toast";
let host: HTMLDivElement | undefined;
let stack: HTMLDivElement | undefined;
const cards = new Map<string, HTMLDivElement>();
const state = new ActivityToastState();
const countdowns = new Map<string, { key: string; animation: Animation }>();
let enabled = true;
let consent = false;
let settingsReady = false;
let seconds = toastSeconds(undefined);
let colors = new Map<string, string>();
let snapshot: ActivitySnapshot = { active: [] };
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const captures = new Map<string, ReturnType<typeof setTimeout>>();

function removeToast() {
  for (const countdown of countdowns.values()) countdown.animation.cancel();
  countdowns.clear();
  host?.remove();
  host = undefined;
  stack = undefined;
  cards.clear();
}

function render() {
  if (hideTimer) clearTimeout(hideTimer);
  if (!settingsReady) { removeToast(); return; }
  if (!enabled || !consent) { state.resetInteraction(); removeToast(); return; }
  if (captures.size) { removeToast(); return; }
  const activities = state.visible(seconds);
  if (!activities.length) { removeToast(); return; }
  if (!host?.isConnected) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483647!important;pointer-events:none!important;width:min(340px,calc(100vw - 24px))!important;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .header { display:flex; align-items:center; justify-content:space-between; gap:10px; color:#edf3fc; background:#141c29; padding:8px 10px; border-radius:8px; margin-bottom:6px; font:600 12px/1.6 system-ui,sans-serif; }
      button { pointer-events:auto; background:transparent; border:1px solid #66758b; border-radius:5px; padding:2px 6px; color:#edf3fc; cursor:pointer; font:11px/1.5 system-ui,sans-serif; }
      .stack { display:flex; flex-direction:column; gap:8px; max-height:65vh; overflow:auto; pointer-events:auto; scrollbar-width:thin; }
      .card { flex:none; background:#141c29; color:#edf3fc; border:1px solid #43516a; border-left:5px solid var(--accent); border-radius:10px; padding:10px 12px; box-shadow:0 4px 12px #0003; font:12px/1.6 system-ui,sans-serif; }
      [hidden] { display:none !important; }
      .card-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px; }
      .retention { color:#afbdcf; font-size:11px; }
      .card-close { flex:none; padding:0 6px; font-size:16px; line-height:20px; }
      .progress { height:3px; margin-top:9px; overflow:hidden; border-radius:3px; background:#edf3fc26; }
      .progress-fill { width:100%; height:100%; background:var(--accent); transform-origin:left; }
      .technical { margin-top:6px; color:#afbdcf; font-size:11px; }
      .technical summary { cursor:pointer; }
      .technical pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0 0; font:inherit; }
      .body { white-space:pre-wrap; overflow-wrap:anywhere; }
    `;
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("span");
    title.textContent = "AgentBridgeLens · 实时操作";
    title.title = "鼠标移入卡片可固定，移出后仍保留，点击卡片关闭按钮移除";
    const close = document.createElement("button");
    close.textContent = "关闭自动提示";
    close.title = "关闭所有网页的悬浮提示，可在插件中重新开启";
    close.addEventListener("click", () => {
      enabled = false;
      removeToast();
      void chrome.storage.local.set({ activityToastEnabled: false }).catch(() => {});
    });
    header.append(title, close);
    stack = document.createElement("div");
    stack.className = "stack";
    cards.clear();
    shadow.append(style, header, stack);
    document.documentElement.appendChild(host);
  }
  const visible = new Set(activities.map((activity) => activity.id));
  for (const [id, card] of cards) {
    if (!visible.has(id)) { countdowns.get(id)?.animation.cancel(); countdowns.delete(id); card.remove(); cards.delete(id); }
  }
  let added = false;
  for (const activity of activities) {
    let card = cards.get(activity.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "card";
      card.dataset.activityId = activity.id;
      const top = document.createElement("div");
      top.className = "card-top";
      const retention = document.createElement("span");
      retention.className = "retention";
      const close = document.createElement("button");
      close.className = "card-close";
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭此条动态");
      close.title = "关闭此条动态，其他提示继续显示";
      close.addEventListener("click", (event) => { event.stopPropagation(); state.dismiss(activity.id); render(); });
      top.append(retention, close);
      const body = document.createElement("div");
      body.className = "body";
      const progress = document.createElement("div");
      progress.className = "progress";
      progress.setAttribute("aria-hidden", "true");
      progress.title = "完成后倒计时，鼠标移入可固定查看";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      progress.appendChild(fill);
      const technical = document.createElement("details");
      technical.className = "technical";
      const summary = document.createElement("summary");
      summary.textContent = "技术细节";
      const detail = document.createElement("pre");
      technical.append(summary, detail);
      card.append(top, body, technical, progress);
      const pin = () => { if (!state.isPinned(activity.id)) { state.pin(activity.id); render(); } };
      card.addEventListener("mouseenter", pin);
      card.addEventListener("focusin", pin);
      cards.set(activity.id, card);
      added = true;
    }
    const color = (activity.bridgeId && colors.get(activity.bridgeId)) || activity.bridgeColor;
    const accent = isBridgeColor(color) ? color : BRIDGE_COLORS[0];
    card.style.setProperty("--accent", accent);
    card.style.backgroundImage = `linear-gradient(100deg, ${accent}24, transparent 75%)`;
    card.querySelector(".body")!.textContent = formatActivityCard(activity);
    card.querySelector(".technical pre")!.textContent = [
      `类别：${activity.dimension}`, `工具：${activity.tool}`,
      activity.tabId !== undefined ? `标签页：${activity.tabId}` : undefined,
      activity.scope,
    ].filter(Boolean).join("\n");
    const pinned = state.isPinned(activity.id);
    card.dataset.pinned = String(pinned);
    card.querySelector(".retention")!.textContent = pinned ? "已固定 · 点击 × 关闭" : activity.state === "running" ? "执行中 · 移入可固定" : "自动关闭 · 移入可固定";
    const progress = card.querySelector<HTMLDivElement>(".progress")!;
    progress.hidden = pinned || activity.finishedAt === undefined || seconds === 0;
    if (progress.hidden) {
      countdowns.get(activity.id)?.animation.cancel();
      countdowns.delete(activity.id);
    } else {
      const key = `${activity.finishedAt}:${seconds}`;
      if (countdowns.get(activity.id)?.key !== key) {
        countdowns.get(activity.id)?.animation.cancel();
        const animation = progress.querySelector(".progress-fill")!.animate([
          { transform: "scaleX(1)" }, { transform: "scaleX(0)" },
        ], { duration: seconds * 1000, fill: "both", easing: "linear" });
        animation.currentTime = Math.max(0, Date.now() - activity.finishedAt!);
        countdowns.set(activity.id, { key, animation });
      }
    }
    // Creation order is stable even when calls complete in a different order.
    stack!.appendChild(card);
  }
  if (added) stack!.scrollTop = stack!.scrollHeight;
  const deadlines = activities.filter((activity) => activity.finishedAt !== undefined && !state.isPinned(activity.id))
    .map((activity) => activity.finishedAt! + seconds * 1000);
  if (deadlines.length) hideTimer = setTimeout(render, Math.max(1, Math.min(...deadlines) - Date.now()));
}

function receive(next: ActivitySnapshot) {
  if ((next.revision ?? 0) < (snapshot.revision ?? 0)) return;
  snapshot = next;
  state.update(next);
  render();
}

export function startActivityToast() {
  const changedSettings = new Set<string>();
  const keys = ["activityToastEnabled", "bridgeConsent", "activityToastSeconds", "bridgeProfiles"];
  function apply(key: string, value: unknown) {
    if (key === "activityToastEnabled") enabled = value !== false;
    if (key === "bridgeConsent") consent = value === true;
    if (key === "activityToastSeconds") seconds = toastSeconds(value);
    if (key === "bridgeProfiles") colors = new Map(withBridgeColors(Array.isArray(value) ? value as BridgeProfile[] : []).map((profile) => [profile.id, profile.color!]));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of keys) {
      if (changes[key]) { changedSettings.add(key); apply(key, changes[key].newValue); }
    }
    render();
  });
  void chrome.storage.local.get(keys).then((settings) => {
    for (const key of keys) if (!changedSettings.has(key)) apply(key, settings[key]);
    settingsReady = true;
    render();
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "bridgelens-activities") {
      receive(message);
    } else if (message?.type === "bridgelens-activity-capture") {
      const token = message.token as string;
      if (message.hide) {
        const oldTimer = captures.get(token);
        if (oldTimer) clearTimeout(oldTimer);
        captures.set(token, setTimeout(() => { captures.delete(token); render(); }, 20000));
        render();
        let finished = false;
        const finish = () => { if (!finished) { finished = true; sendResponse({ ok: true }); } };
        setTimeout(finish, 80);
        requestAnimationFrame(() => requestAnimationFrame(finish));
        return true;
      }
      const timer = captures.get(token);
      if (timer) clearTimeout(timer);
      captures.delete(token);
      render();
      sendResponse({ ok: true });
    }
  });
  void chrome.runtime.sendMessage({ type: "bridgelens-get-activities" }).then((next) => {
    if (next) receive(next);
  }).catch(() => {});
}
