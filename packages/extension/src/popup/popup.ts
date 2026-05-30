import { getBridgeConfig, setBridgeConfig, DEFAULT_HOST, DEFAULT_PORT } from "../shared/config";

const hostInput = document.getElementById("host") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "bridgelens-get-status" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = "状态未知";
      statusEl.className = "status";
      return;
    }
    if (res.connected) {
      statusEl.textContent = `已连接 ${res.url}`;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent = "未连接（确认 Bridge Server 已启动）";
      statusEl.className = "status bad";
    }
  });
}

async function load() {
  const { host, port, token } = await getBridgeConfig();
  hostInput.value = host;
  portInput.value = String(port);
  tokenInput.value = token;
  refreshStatus();
}

saveBtn.addEventListener("click", async () => {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  const token = tokenInput.value.trim();
  await setBridgeConfig({ host, port, token });
  statusEl.textContent = "已保存，重连中…";
  statusEl.className = "status";
  setTimeout(refreshStatus, 600);
});

load();
setInterval(refreshStatus, 2000);

// ---- 目标标签页 ----
const targetEl = document.getElementById("target") as HTMLDivElement;
const tablistEl = document.getElementById("tablist") as HTMLDivElement;
const policyEl = document.getElementById("policy") as HTMLSelectElement;
const clearTargetBtn = document.getElementById("clear-target") as HTMLButtonElement;

async function getTargetId(): Promise<number | null> {
  const { targetTabId } = await chrome.storage.session.get("targetTabId");
  return typeof targetTabId === "number" ? targetTabId : null;
}

async function renderTabs() {
  const targetId = await getTargetId();
  const tabs = await chrome.tabs.query({});

  if (targetId === null) {
    targetEl.textContent = "跟随当前激活标签页";
  } else {
    const t = tabs.find((x) => x.id === targetId);
    targetEl.textContent = t ? `🎯 ${t.title || t.url || targetId}` : "（原目标已关闭，跟随激活页）";
  }

  tablistEl.innerHTML = "";
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    const row = document.createElement("div");
    row.className = "tab" + (t.id === targetId ? " is-target" : "");

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = t.title || "(无标题)";
    const url = document.createElement("div");
    url.className = "u";
    try {
      url.textContent = t.url ? new URL(t.url).host || t.url : "";
    } catch {
      url.textContent = t.url || "";
    }
    meta.appendChild(title);
    meta.appendChild(url);
    row.appendChild(meta);

    if (t.id === targetId) {
      const tag = document.createElement("span");
      tag.className = "pin";
      tag.textContent = "目标";
      row.appendChild(tag);
    } else {
      const btn = document.createElement("button");
      btn.textContent = "设为目标";
      const id = t.id;
      btn.addEventListener("click", async () => {
        await chrome.storage.session.set({ targetTabId: id });
        renderTabs();
      });
      row.appendChild(btn);
    }
    tablistEl.appendChild(row);
  }
}

clearTargetBtn.addEventListener("click", async () => {
  await chrome.storage.session.remove("targetTabId");
  renderTabs();
});

policyEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ newTabPolicy: policyEl.value });
});

async function loadPolicy() {
  const { newTabPolicy } = await chrome.storage.local.get("newTabPolicy");
  policyEl.value = newTabPolicy === "follow" ? "follow" : "stay";
}

loadPolicy();
renderTabs();
setInterval(renderTabs, 2000);
