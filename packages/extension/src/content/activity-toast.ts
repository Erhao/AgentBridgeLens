import { formatActivity, type Activity, type ActivitySnapshot } from "../shared/activity";

const HOST_ID = "bridgelens-activity-toast";
const HIDE_DELAY = 4000;
let host: HTMLDivElement | undefined;
let body: HTMLDivElement | undefined;
let enabled = true;
let consent = false;
let settingsReady = false;
let snapshot: ActivitySnapshot = { active: [] };
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const captures = new Map<string, ReturnType<typeof setTimeout>>();

function removeToast() {
  host?.remove();
  host = undefined;
  body = undefined;
}

function render() {
  if (hideTimer) clearTimeout(hideTimer);
  if (!settingsReady || !enabled || !consent || captures.size) { removeToast(); return; }
  const active = snapshot.active;
  const last = snapshot.last;
  const remaining = last?.finishedAt === undefined ? 0 : HIDE_DELAY - (Date.now() - last.finishedAt);
  if (!active.length && (!last || remaining <= 0)) { removeToast(); return; }
  if (!host?.isConnected) {
    host = document.createElement("div");
    host.id = HOST_ID;
    // The overlay is extension UI, excluded from the page's accessibility tree.
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483647!important;pointer-events:none!important;width:min(340px,calc(100vw - 24px))!important;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .card { background:#141c29; color:#edf3fc; border:1px solid #43516a; border-radius:12px; padding:12px; box-shadow:0 6px 28px #0005; font:12px/1.6 system-ui,sans-serif; }
      .header { display:flex; align-items:center; justify-content:space-between; gap:10px; font-weight:600; margin-bottom:6px; }
      button { pointer-events:auto; background:transparent; border:1px solid #66758b; border-radius:5px; padding:2px 6px; color:#edf3fc; cursor:pointer; font:11px/1.5 system-ui,sans-serif; }
      .body { white-space:pre-wrap; overflow-wrap:anywhere; max-height:35vh; overflow:auto; pointer-events:auto; }
    `;
    const card = document.createElement("div");
    card.className = "card";
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
    body = document.createElement("div");
    body.className = "body";
    card.append(header, body);
    shadow.append(style, card);
    document.documentElement.appendChild(host);
  }
  body!.textContent = active.length
    ? active.map(formatActivity).join("\n\n")
    : formatActivity(last!);
  if (!active.length) hideTimer = setTimeout(removeToast, Math.max(0, remaining));
}

function receive(next: ActivitySnapshot) {
  if ((next.revision ?? 0) < (snapshot.revision ?? 0)) return;
  snapshot = next;
  render();
}

/** Called in the top-frame content script, without opening any extension panel. */
export function startActivityToast() {
  const changedSettings = new Set<string>();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.activityToastEnabled && !changes.bridgeConsent)) return;
    for (const key of Object.keys(changes)) changedSettings.add(key);
    if (changes.activityToastEnabled) enabled = changes.activityToastEnabled.newValue !== false;
    if (changes.bridgeConsent) consent = changes.bridgeConsent.newValue === true;
    render();
  });
  void chrome.storage.local.get(["activityToastEnabled", "bridgeConsent"]).then((settings) => {
    if (!changedSettings.has("activityToastEnabled")) enabled = settings.activityToastEnabled !== false;
    if (!changedSettings.has("bridgeConsent")) consent = settings.bridgeConsent === true;
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
        // Allow the compositor to remove the overlay before screenshotting.
        // Background pages may throttle animation frames, so bound the wait.
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
