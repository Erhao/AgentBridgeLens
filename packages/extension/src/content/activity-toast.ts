import { formatActivity, visibleActivities, type ActivitySnapshot } from "../shared/activity";
import { toastSeconds, withBridgeColors, isBridgeColor, BRIDGE_COLORS, type BridgeProfile } from "../shared/config";

const HOST_ID = "bridgelens-activity-toast";
let host: HTMLDivElement | undefined;
let stack: HTMLDivElement | undefined;
const cards = new Map<string, HTMLDivElement>();
let enabled = true;
let consent = false;
let settingsReady = false;
let seconds = toastSeconds(undefined);
let colors = new Map<string, string>();
let snapshot: ActivitySnapshot = { active: [] };
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const captures = new Map<string, ReturnType<typeof setTimeout>>();

function removeToast() {
  host?.remove();
  host = undefined;
  stack = undefined;
  cards.clear();
}

function render() {
  if (hideTimer) clearTimeout(hideTimer);
  if (!settingsReady || !enabled || !consent || captures.size) { removeToast(); return; }
  const activities = visibleActivities(snapshot, seconds);
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
      .body { white-space:pre-wrap; overflow-wrap:anywhere; }
    `;
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("span");
    title.textContent = "AgentBridgeLens · 实时操作";
    const close = document.createElement("button");
    close.textContent = "关闭悬浮提示";
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
    if (!visible.has(id)) { card.remove(); cards.delete(id); }
  }
  let added = false;
  for (const activity of activities) {
    let card = cards.get(activity.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "card";
      card.dataset.activityId = activity.id;
      const body = document.createElement("div");
      body.className = "body";
      card.appendChild(body);
      cards.set(activity.id, card);
      added = true;
    }
    const color = (activity.bridgeId && colors.get(activity.bridgeId)) || activity.bridgeColor;
    const accent = isBridgeColor(color) ? color : BRIDGE_COLORS[0];
    card.style.setProperty("--accent", accent);
    card.style.backgroundImage = `linear-gradient(100deg, ${accent}24, transparent 75%)`;
    card.querySelector(".body")!.textContent = formatActivity(activity);
    // Creation order is stable even when calls complete in a different order.
    stack!.appendChild(card);
  }
  if (added) stack!.scrollTop = stack!.scrollHeight;
  const deadlines = activities.filter((activity) => activity.finishedAt !== undefined)
    .map((activity) => activity.finishedAt! + seconds * 1000);
  if (deadlines.length) hideTimer = setTimeout(render, Math.max(1, Math.min(...deadlines) - Date.now()));
}

function receive(next: ActivitySnapshot) {
  if ((next.revision ?? 0) < (snapshot.revision ?? 0)) return;
  snapshot = next;
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
