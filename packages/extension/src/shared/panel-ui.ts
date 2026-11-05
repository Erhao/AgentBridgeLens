import { formatActivity, type Activity } from "./activity";
/**
 * popup 与 side panel 共用的「连接配置 + 目标标签页」控件。
 * mountControls(root) 注入样式 + 构建 DOM + 接好全部逻辑。
 * 目标是一组（可固定多个）；每个固定目标行上单独设「新标签策略」。
 */
import { getBridgeProfiles, setBridgeProfiles, DEFAULT_HOST, DEFAULT_PORT, type BridgeProfile } from "./config";

type Policy = "stay" | "follow";

const STYLE = `
  .bl-h1 { font-size: 14px; margin: 0 0 10px; }
  .status { font-size: 12px; padding: 6px 8px; border-radius: 6px; margin-bottom: 12px; background: #f0f2f5; white-space: pre-line; overflow-wrap: anywhere; }
  .status.ok { background: #e3f9e5; color: #207227; }
  .status.bad { background: #fff0f0; color: #ab1c1c; }
  .status.bl-bridges { background: transparent; padding: 0; }
  .bl-bridge-line { padding: 6px 8px; margin-bottom: 4px; border-radius: 6px; }
  .bl-bridge-line.ok { background: #e3f9e5; color: #207227; }
  .bl-bridge-line.bad { background: #fff0f0; color: #ab1c1c; }
  .bl-connection-hint { color: #627080; padding: 2px 0; }
  .bl [hidden] { display: none !important; }
  .bl label { display: block; font-size: 12px; margin-bottom: 8px; }
  .bl select { max-width: 100%; padding: 5px; margin: 4px 0; }
  .bl .bl-service-actions { display: flex; gap: 8px; margin-bottom: 8px; }
  .bl input { width: 100%; box-sizing: border-box; padding: 5px 6px; margin-top: 3px; border: 1px solid #cbd2d9; border-radius: 5px; font-size: 13px; }
  #bl-save { width: 100%; padding: 7px; margin-top: 4px; border: none; border-radius: 6px; background: #4a90d9; color: #fff; font-size: 13px; cursor: pointer; }
  #bl-save:hover { background: #3a7bc0; }
  .bl .bl-privacy { font-size: 12px; line-height: 1.5; background: #eef4fb; padding: 8px; border-radius: 6px; margin-bottom: 10px; }
  .bl .bl-consent { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0; }
  .bl .bl-consent input { width: auto; margin-top: 3px; }
  .bl .bl-privacy a { color: #2d6fd6; }
  .bl details { margin-bottom: 6px; }
  .bl summary { cursor: pointer; font-size: 12px; color: #4a90d9; user-select: none; }
  .bl hr { border: none; border-top: 1px solid #eef1f4; margin: 10px 0; }
  .bl-h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #7b8794; margin: 0 0 6px; display: flex; align-items: center; justify-content: space-between; }
  #bl-clear-all { text-transform: none; letter-spacing: 0; background: none; border: none; color: #4a90d9; cursor: pointer; font-size: 11px; padding: 0; }
  .bl-target { font-size: 12px; background: #eef4fb; border-radius: 6px; padding: 5px 8px; margin-bottom: 8px; word-break: break-all; }
  .bl .bl-target-select { display: block; width: 100%; box-sizing: border-box; }
  .bl .bl-target-help { font-size: 12px; color: #627080; line-height: 1.5; margin: 4px 0 8px; }
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
  <label class="bl-consent"><input id="bl-activity-enabled" type="checkbox" checked />面板内显示实时状态</label>
  <label class="bl-consent"><input id="bl-toast-enabled" type="checkbox" checked />网页自动显示悬浮状态</label>
  <div id="bl-activity" class="status" role="status" aria-live="polite">等待 Agent 调用…</div>
  <details id="bl-privacy">
    <summary>数据访问与授权</summary>
    <div class="bl-privacy" style="margin-top:8px">
    连接后，AI 可通过你配置的 Bridge 读取标签页信息、网页内容、截图、调试日志，并执行网页操作；启动录制后还可记录输入内容。数据会发送到 Bridge 及其连接的 AI 客户端，可能离开本机。请仅连接可信服务，并避免在敏感页面使用。
    <a href="/privacy.html" target="_blank" rel="noopener">隐私政策 / Privacy policy</a>
    <label class="bl-consent"><input id="bl-consent" type="checkbox" />我同意上述数据访问和传输，并启用 Bridge 连接</label>
    <button id="bl-apply-consent" type="button">应用授权设置</button>
    </div>
  </details>
  <details id="bl-conn">
    <summary>桥接服务（可同时连接多个）</summary>
    <label>选择服务 <select id="bl-service"></select></label>
    <div class="bl-service-actions"><button id="bl-add" type="button">添加服务</button><button id="bl-delete" type="button">删除服务</button></div>
    <label>服务名称 <input id="bl-name" type="text" placeholder="例如：开发机 / 笔记本" /></label>
    <label class="bl-consent"><input id="bl-enabled" type="checkbox" />启用此服务</label>
    <label>Host <input id="bl-host" type="text" placeholder="127.0.0.1" /></label>
    <label>Port <input id="bl-port" type="number" min="1" max="65535" placeholder="19222" /></label>
    <label>Token <span style="color:#7b8794">（跨机时必填）</span>
      <input id="bl-token" type="password" placeholder="BRIDGELENS_TOKEN" autocomplete="off" /></label>
    <button id="bl-save">保存此服务</button>
  </details>
  <hr />
  <h2 class="bl-h2">操作页面</h2>
  <label>操作方式
    <select id="bl-target-mode" class="bl-target-select">
      <option value="current">操作当前页</option>
      <option value="pinned">固定指定页</option>
    </select>
  </label>
  <label id="bl-page-picker" hidden>指定页面
    <select id="bl-target-page" class="bl-target-select" aria-label="选择固定操作的页面"></select>
  </label>
  <div id="bl-target" class="bl-target">正在获取操作页面…</div>
  <p class="bl-target-help">操作当前页会随你切换标签页；固定后，切换标签页也会继续操作指定页面。</p>
  <details id="bl-target-advanced">
    <summary>高级设置：多目标与新标签跟随</summary>
    <p class="bl-target-help">可添加多个固定页面，并选择是否自动加入它打开的新标签。多个目标时优先使用当前激活的目标，否则使用最后加入的目标。AI 明确指定页面时以指定页面为准；所有 Bridge 共用此设置。</p>
    <h3 class="bl-h2">固定页面 <button id="bl-clear-all">全部取消</button></h3>
    <div id="bl-tablist"></div>
  </details>
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

  const serviceSelect = root.querySelector<HTMLSelectElement>("#bl-service")!;
  const nameInput = root.querySelector<HTMLInputElement>("#bl-name")!;
  const enabledInput = root.querySelector<HTMLInputElement>("#bl-enabled")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#bl-add")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#bl-delete")!;
  let profiles: BridgeProfile[] = [];
  let selectedId = "";
  const statusEl = root.querySelector<HTMLDivElement>("#bl-status")!;
  const hostInput = root.querySelector<HTMLInputElement>("#bl-host")!;
  const portInput = root.querySelector<HTMLInputElement>("#bl-port")!;
  const tokenInput = root.querySelector<HTMLInputElement>("#bl-token")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#bl-save")!;
  const targetEl = root.querySelector<HTMLDivElement>("#bl-target")!;
  const targetMode = root.querySelector<HTMLSelectElement>("#bl-target-mode")!;
  const pagePicker = root.querySelector<HTMLLabelElement>("#bl-page-picker")!;
  const targetPage = root.querySelector<HTMLSelectElement>("#bl-target-page")!;
  const advancedTargets = root.querySelector<HTMLDetailsElement>("#bl-target-advanced")!;
  const tablistEl = root.querySelector<HTMLDivElement>("#bl-tablist")!;
  const clearAllBtn = root.querySelector<HTMLButtonElement>("#bl-clear-all")!;
  const privacyDetails = root.querySelector<HTMLDetailsElement>("#bl-privacy")!;
  const consentInput = root.querySelector<HTMLInputElement>("#bl-consent")!;
  const applyConsentBtn = root.querySelector<HTMLButtonElement>("#bl-apply-consent")!;

  const toastToggle = root.querySelector<HTMLInputElement>("#bl-toast-enabled")!;
  toastToggle.addEventListener("change", () => {
    void chrome.storage.local.set({ activityToastEnabled: toastToggle.checked });
  });
  let toastSettingRevision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.activityToastEnabled) {
      toastSettingRevision++;
      toastToggle.checked = changes.activityToastEnabled.newValue !== false;
    }
  });
  const initialToastRevision = toastSettingRevision;
  void chrome.storage.local.get("activityToastEnabled").then(({ activityToastEnabled }) => {
    if (toastSettingRevision === initialToastRevision) toastToggle.checked = activityToastEnabled !== false;
  });

  const activityToggle = root.querySelector<HTMLInputElement>("#bl-activity-enabled")!;
  const activityEl = root.querySelector<HTMLDivElement>("#bl-activity")!;
  let activitySnapshot: { active?: Activity[]; last?: Activity } = {};
  let activityVersion = 0;
  function renderActivity() {
    activityEl.hidden = !activityToggle.checked;
    if (!activityToggle.checked) return;
    const active = activitySnapshot.active ?? [];
    activityEl.textContent = active.length
      ? active.map(formatActivity).join("\n\n")
      : activitySnapshot.last ? `当前空闲 · 最近一次操作\n${formatActivity(activitySnapshot.last)}` : "等待 Agent 调用…";
  }
  activityToggle.addEventListener("change", () => {
    renderActivity();
    void chrome.storage.local.set({ activityDisplayEnabled: activityToggle.checked });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.activityDisplayEnabled) {
      activityToggle.checked = changes.activityDisplayEnabled.newValue !== false;
      renderActivity();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "bridgelens-activities") return;
    activityVersion++;
    activitySnapshot = message;
    renderActivity();
  });
  const initialActivityVersion = activityVersion;
  void chrome.runtime.sendMessage({ type: "bridgelens-get-activities" }).then((snapshot) => {
    if (activityVersion === initialActivityVersion && snapshot) activitySnapshot = snapshot;
    renderActivity();
  }).catch(() => {});
  void chrome.storage.local.get("activityDisplayEnabled").then(({ activityDisplayEnabled }) => {
    activityToggle.checked = activityDisplayEnabled !== false;
    renderActivity();
  });

  async function refreshStatus() {
    const { bridgeConsent } = await chrome.storage.local.get("bridgeConsent");
    if (bridgeConsent !== true) {
      statusEl.textContent = "连接已暂停：请阅读数据说明，勾选并应用授权后再连接。";
      statusEl.className = "status";
      return;
    }
    chrome.runtime.sendMessage({ type: "bridgelens-get-status" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusEl.textContent = "状态未知";
        statusEl.className = "status";
        return;
      }
      const bridges = res.bridges as { id: string; name: string; url: string; connected: boolean }[] | undefined;
      statusEl.replaceChildren();
      statusEl.className = "status";
      if (!bridges?.length) {
        statusEl.textContent = "暂无启用的桥接服务，请在下方添加并保存。";
        return;
      }
      statusEl.classList.add("bl-bridges");
      for (const bridge of bridges) {
        const row = document.createElement("div");
        row.className = `bl-bridge-line ${bridge.connected ? "ok" : "bad"}`;
        row.textContent = `${bridge.connected ? "已连接" : "未连接"} · ${bridge.name} · ${bridge.url}`;
        statusEl.appendChild(row);
      }
      if (bridges.some((bridge) => !bridge.connected)) {
        const hint = document.createElement("div");
        hint.className = "bl-connection-hint";
        hint.textContent = "未连接的服务：请检查是否已启动，Host / Port / Token 是否一致，以及网络是否可达。";
        statusEl.appendChild(hint);
      }
    });
  }

  function renderEditor() {
    serviceSelect.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.enabled ? "" : "已停用 · "}${profile.name}`;
      serviceSelect.appendChild(option);
    }
    const profile = profiles.find((p) => p.id === selectedId);
    serviceSelect.value = selectedId;
    nameInput.value = profile?.name ?? "";
    hostInput.value = profile?.host ?? DEFAULT_HOST;
    portInput.value = String(profile?.port ?? DEFAULT_PORT);
    tokenInput.value = profile?.token ?? "";
    enabledInput.checked = profile?.enabled ?? true;
    saveBtn.disabled = !profile;
    deleteBtn.disabled = !profile;
  }

  async function loadConfig() {
    profiles = await getBridgeProfiles();
    selectedId = profiles[0]?.id ?? "";
    renderEditor();
    const { bridgeConsent } = await chrome.storage.local.get("bridgeConsent");
    consentInput.checked = bridgeConsent === true;
    privacyDetails.open = !consentInput.checked;
  }

  serviceSelect.addEventListener("change", () => {
    selectedId = serviceSelect.value;
    renderEditor();
  });
  addBtn.addEventListener("click", () => {
    selectedId = crypto.randomUUID();
    profiles.push({ id: selectedId, name: `服务 ${profiles.length + 1}`, host: DEFAULT_HOST, port: DEFAULT_PORT, token: "", enabled: true });
    renderEditor();
  });
  deleteBtn.addEventListener("click", async () => {
    try {
      const saved = await getBridgeProfiles();
      await setBridgeProfiles(saved.filter((p) => p.id !== selectedId));
      await loadConfig();
      await refreshStatus();
    } catch (error) {
      statusEl.textContent = String(error);
      statusEl.className = "status bad";
    }
  });

  applyConsentBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ bridgeConsent: consentInput.checked });
    privacyDetails.open = !consentInput.checked;
    await refreshStatus();
  });

  saveBtn.addEventListener("click", async () => {
    const profile: BridgeProfile = {
      id: selectedId, name: nameInput.value.trim() || "未命名服务",
      host: hostInput.value.trim() || DEFAULT_HOST,
      port: Number(portInput.value || DEFAULT_PORT), token: tokenInput.value.trim(),
      enabled: enabledInput.checked,
    };
    try {
      const saved = await getBridgeProfiles();
      const updated = saved.filter((p) => p.id !== selectedId);
      updated.push(profile);
      await setBridgeProfiles(updated);
      profiles = updated;
      renderEditor();
      statusEl.textContent = "已保存服务设置，正在检查连接…";
      statusEl.className = "status";
      setTimeout(refreshStatus, 600);
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : String(error);
      statusEl.className = "status bad";
    }
  });

  let targetMutation = false;
  async function changeTargetMode() {
    targetMutation = true;
    targetMode.disabled = true;
    targetPage.disabled = true;
    try {
      if (targetMode.value === "current") {
        await setTargets([]);
      } else {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (typeof active?.id !== "number") throw new Error("没有可固定的当前页面");
        await setTargets([active.id]);
      }
    } catch (error) {
      targetEl.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      targetMutation = false;
      targetMode.disabled = false;
      targetPage.disabled = false;
      void renderTabs();
    }
  }
  targetMode.addEventListener("change", () => { void changeTargetMode(); });
  targetPage.addEventListener("change", async () => {
    if (!targetPage.value) return;
    targetMutation = true;
    targetMode.disabled = true;
    targetPage.disabled = true;
    try {
      await setTargets([Number(targetPage.value)]);
    } finally {
      targetMutation = false;
      targetMode.disabled = false;
      targetPage.disabled = false;
      void renderTabs();
    }
  });
  advancedTargets.addEventListener("toggle", () => { void renderTabs(); });

  clearAllBtn.addEventListener("click", async () => {
    await setTargets([]);
    renderTabs();
  });

  let renderingTabs = false;
  let pageOptionsKey = "";
  async function renderTabs() {
    if (renderingTabs || targetMutation) return;
    renderingTabs = true;
    try {
      const [targets, policies, fallback, tabs, activeTabs] = await Promise.all([
        getTargets(), getTabPolicies(), getGlobalPolicy(), chrome.tabs.query({}),
        chrome.tabs.query({ active: true, currentWindow: true }),
      ]);
      if (targetMutation) return;
      const liveTargets = targets.filter((id) => tabs.some((t) => t.id === id));
      const pinned = liveTargets.length > 0;
      targetMode.value = pinned ? "pinned" : "current";
      pagePicker.hidden = !pinned;
      const fixedPage = tabs.find((tab) => tab.id === liveTargets[0]);
      targetEl.textContent = !pinned
        ? `当前页：${activeTabs[0]?.title || "暂无可用页面"}`
        : liveTargets.length === 1
          ? `已固定：${fixedPage?.title || "(无标题)"}`
          : `已固定 ${liveTargets.length} 个页面，可在高级设置中管理`;

      // Avoid rebuilding native select options during the periodic refresh when unchanged.
      const optionsKey = JSON.stringify([tabs.map((tab) => [tab.id, tab.title]), liveTargets]);
      if (optionsKey !== pageOptionsKey) {
        pageOptionsKey = optionsKey;
        targetPage.replaceChildren();
        if (liveTargets.length > 1) {
          const multi = document.createElement("option");
          multi.value = "";
          multi.textContent = `已固定 ${liveTargets.length} 个页面（选择一个将改为单目标）`;
          multi.disabled = true;
          targetPage.appendChild(multi);
        }
        for (const tab of tabs) {
          if (typeof tab.id !== "number") continue;
          const option = document.createElement("option");
          option.value = String(tab.id);
          option.textContent = tab.title || "(无标题)";
          targetPage.appendChild(option);
        }
        targetPage.value = liveTargets.length === 1 ? String(liveTargets[0]) : "";
      }

      if (!advancedTargets.open) return;
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
    } finally {
      renderingTabs = false;
    }
  }

  loadConfig();
  refreshStatus();
  renderTabs();
  setInterval(refreshStatus, 2000);
  setInterval(renderTabs, 2000);
}
