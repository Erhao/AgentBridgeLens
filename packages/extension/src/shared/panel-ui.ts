/**
 * popup 与 side panel 共用的「连接配置 + 目标标签页」控件。
 * mountControls(root) 注入样式 + 构建 DOM + 接好全部逻辑。
 * 目标是一组（可固定多个）；每个固定目标行上单独设「新标签策略」。
 */
import { getBridgeConfig, setBridgeConfig, DEFAULT_HOST, DEFAULT_PORT } from "./config";

type Policy = "stay" | "follow";

const STYLE = `
  .bl-h1 { font-size: 14px; margin: 0 0 10px; }
  .status { font-size: 12px; padding: 6px 8px; border-radius: 6px; margin-bottom: 12px; background: #f0f2f5; }
  .status.ok { background: #e3f9e5; color: #207227; }
  .status.bad { background: #fff0f0; color: #ab1c1c; }
  .bl label { display: block; font-size: 12px; margin-bottom: 8px; }
  .bl input { width: 100%; box-sizing: border-box; padding: 5px 6px; margin-top: 3px; border: 1px solid #cbd2d9; border-radius: 5px; font-size: 13px; }
  #bl-save { width: 100%; padding: 7px; margin-top: 4px; border: none; border-radius: 6px; background: #4a90d9; color: #fff; font-size: 13px; cursor: pointer; }
  #bl-save:hover { background: #3a7bc0; }
  .bl details { margin-bottom: 6px; }
  .bl summary { cursor: pointer; font-size: 12px; color: #4a90d9; user-select: none; }
  .bl hr { border: none; border-top: 1px solid #eef1f4; margin: 10px 0; }
  .bl-h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #7b8794; margin: 0 0 6px; display: flex; align-items: center; justify-content: space-between; }
  #bl-clear-all { text-transform: none; letter-spacing: 0; background: none; border: none; color: #4a90d9; cursor: pointer; font-size: 11px; padding: 0; }
  .bl-target { font-size: 12px; background: #eef4fb; border-radius: 6px; padding: 5px 8px; margin-bottom: 8px; word-break: break-all; }
  #bl-tablist { max-height: 440px; overflow: auto; border: 1px solid #eef1f4; border-radius: 6px; }
  .bl-tab { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-bottom: 1px solid #f3f5f7; font-size: 12px; }
  .bl-tab:last-child { border-bottom: none; }
  .bl-tab.is-target { background: #e3f9e5; }
  .bl-tab .meta { flex: 1; min-width: 0; }
  .bl-tab .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-tab .u { color: #9aa5b1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-tab button { width: auto; margin: 0; padding: 3px 7px; font-size: 11px; flex: 0 0 auto; border: none; border-radius: 4px; cursor: pointer; }
  .bl-tab .pin-btn { background: #4a90d9; color: #fff; }
  .bl-tab .unpin-btn { background: #9aa5b1; color: #fff; }
  .bl-tab select { flex: 0 0 auto; font-size: 11px; padding: 2px; border: 1px solid #cbd2d9; border-radius: 4px; max-width: 92px; }
`;

const MARKUP = `
  <h1 class="bl-h1">AgentBridgeLens</h1>
  <div id="bl-status" class="status">检查连接中…</div>
  <details id="bl-conn">
    <summary>连接设置（Host / Port / Token）</summary>
    <label>Host <input id="bl-host" type="text" placeholder="127.0.0.1" /></label>
    <label>Port <input id="bl-port" type="number" min="1" max="65535" placeholder="19222" /></label>
    <label>Token <span style="color:#7b8794">（跨机时必填）</span>
      <input id="bl-token" type="password" placeholder="BRIDGELENS_TOKEN" autocomplete="off" /></label>
    <button id="bl-save">保存并重连</button>
  </details>
  <hr />
  <h2 class="bl-h2">目标标签页 <button id="bl-clear-all">全部取消</button></h2>
  <div id="bl-target" class="bl-target">跟随当前激活标签页</div>
  <div id="bl-tablist"></div>
`;

async function getTargets(): Promise<number[]> {
  const { targetTabIds } = await chrome.storage.session.get("targetTabIds");
  return Array.isArray(targetTabIds) ? targetTabIds.filter((x) => typeof x === "number") : [];
}
async function setTargets(ids: number[]): Promise<void> {
  await chrome.storage.session.set({ targetTabIds: ids });
}
async function getGlobalPolicy(): Promise<Policy> {
  const { newTabPolicy } = await chrome.storage.local.get("newTabPolicy");
  return newTabPolicy === "follow" ? "follow" : "stay";
}
async function getTabPolicies(): Promise<Record<string, Policy>> {
  const { tabPolicies } = await chrome.storage.session.get("tabPolicies");
  return tabPolicies && typeof tabPolicies === "object" ? tabPolicies : {};
}
async function setTabPolicy(tabId: number, policy: Policy): Promise<void> {
  const tp = await getTabPolicies();
  tp[String(tabId)] = policy;
  await chrome.storage.session.set({ tabPolicies: tp });
}

export function mountControls(root: HTMLElement): void {
  if (!document.getElementById("bl-style")) {
    const s = document.createElement("style");
    s.id = "bl-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }
  root.classList.add("bl");
  root.innerHTML = MARKUP;

  const statusEl = root.querySelector<HTMLDivElement>("#bl-status")!;
  const hostInput = root.querySelector<HTMLInputElement>("#bl-host")!;
  const portInput = root.querySelector<HTMLInputElement>("#bl-port")!;
  const tokenInput = root.querySelector<HTMLInputElement>("#bl-token")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#bl-save")!;
  const targetEl = root.querySelector<HTMLDivElement>("#bl-target")!;
  const tablistEl = root.querySelector<HTMLDivElement>("#bl-tablist")!;
  const clearAllBtn = root.querySelector<HTMLButtonElement>("#bl-clear-all")!;

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "bridgelens-get-status" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusEl.textContent = "状态未知";
        statusEl.className = "status";
        return;
      }
      statusEl.textContent = res.connected ? `已连接 ${res.url}` : "未连接（确认 Bridge Server 已启动）";
      statusEl.className = res.connected ? "status ok" : "status bad";
    });
  }

  async function loadConfig() {
    const { host, port, token } = await getBridgeConfig();
    hostInput.value = host;
    portInput.value = String(port);
    tokenInput.value = token;
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

  clearAllBtn.addEventListener("click", async () => {
    await setTargets([]);
    renderTabs();
  });

  async function renderTabs() {
    const targets = await getTargets();
    const policies = await getTabPolicies();
    const fallback = await getGlobalPolicy();
    const tabs = await chrome.tabs.query({});

    const liveTargets = targets.filter((id) => tabs.some((t) => t.id === id));
    targetEl.textContent =
      liveTargets.length === 0
        ? "跟随当前激活标签页"
        : `🎯 已固定 ${liveTargets.length} 个（无 tabId 调用时用最近活跃的那个）`;

    tablistEl.innerHTML = "";
    for (const t of tabs) {
      if (typeof t.id !== "number") continue;
      const id = t.id;
      const isTarget = targets.includes(id);
      const row = document.createElement("div");
      row.className = "bl-tab" + (isTarget ? " is-target" : "");

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

      if (isTarget) {
        // 每个目标各自的新标签策略
        const sel = document.createElement("select");
        sel.innerHTML =
          '<option value="stay">不跟随</option><option value="follow">跟随新标签</option>';
        sel.value = policies[String(id)] ?? fallback;
        sel.title = "该目标页打开新标签时的处理";
        sel.addEventListener("change", () => setTabPolicy(id, sel.value as Policy));
        row.appendChild(sel);

        const unpin = document.createElement("button");
        unpin.className = "unpin-btn";
        unpin.textContent = "取消";
        unpin.addEventListener("click", async () => {
          await setTargets((await getTargets()).filter((x) => x !== id));
          renderTabs();
        });
        row.appendChild(unpin);
      } else {
        const pin = document.createElement("button");
        pin.className = "pin-btn";
        pin.textContent = "设为目标";
        pin.addEventListener("click", async () => {
          const cur = await getTargets();
          if (!cur.includes(id)) cur.push(id);
          await setTargets(cur);
          renderTabs();
        });
        row.appendChild(pin);
      }
      tablistEl.appendChild(row);
    }
  }

  loadConfig();
  refreshStatus();
  renderTabs();
  setInterval(refreshStatus, 2000);
  setInterval(renderTabs, 2000);
}
