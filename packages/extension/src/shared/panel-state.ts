import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { formatActivity, type ActivitySnapshot } from "./activity";
import { getBridgeProfiles, setBridgeProfiles, DEFAULT_HOST, DEFAULT_PORT, BRIDGE_COLORS, withBridgeColors, toastSeconds, type BridgeProfile } from "./config";
import type { BridgeStatus } from "../background/bridge-connections";

type Policy = "stay" | "follow";
interface ServiceEditor {
  profile: BridgeProfile;
  draft: BridgeProfile;
  saved: boolean;
  busy: boolean;
  retrying: boolean;
  error: string;
}

export function usePanelState() {
  const ready = ref(false);
  const settings = reactive({ panel: true, toast: true, seconds: toastSeconds(undefined) });
  const consent = ref(false);
  const consentDraft = ref(false);
  const sections = ref<string[]>([]);
  const openServices = ref<string[]>([]);
  const services = ref<ServiceEditor[]>([]);
  const bridges = ref<BridgeStatus[]>([]);
  const statusError = ref("");
  const pageError = ref("");
  const snapshot = ref<ActivitySnapshot>({ active: [] });
  const tabs = ref<chrome.tabs.Tab[]>([]);
  const activeTitle = ref("");
  const targets = ref<number[]>([]);
  const policies = ref<Record<string, Policy>>({});
  const globalPolicy = ref<Policy>("stay");
  const targetBusy = ref(false);
  const targetMode = ref("current");
  const targetPage = ref<number>();
  const now = ref(Date.now());
  const changed = new Set<string>();
  let activityRevision = 0;
  let statusRevision = 0;
  let tabsRevision = 0;
  let active = true;
  const timers: ReturnType<typeof setInterval>[] = [];
  const activityText = computed(() => snapshot.value.active.length
    ? snapshot.value.active.map(formatActivity).join("\n\n")
    : snapshot.value.last ? `当前空闲 · 最近一次操作\n${formatActivity(snapshot.value.last)}` : "等待 Agent 调用…");
  const targetText = computed(() => pageError.value || (!targets.value.length
    ? `当前页：${activeTitle.value || "暂无可用页面"}`
    : targets.value.length === 1 ? `已固定：${tabs.value.find((tab) => tab.id === targets.value[0])?.title || "(无标题)"}`
      : `已固定 ${targets.value.length} 个页面，可在高级设置中管理`));
  const connectionHint = computed(() => statusError.value || (!consent.value
    ? "连接已暂停：请阅读数据说明，勾选并应用授权后再连接。"
    : !services.value.length ? "暂无桥接服务，请添加服务。"
      : services.value.some((service) => service.saved && service.profile.enabled && !bridge(service)?.connected)
        ? "已启用自动重连：失败后等待 3 秒起，每次翻倍，最长 600 秒；每次连接最多等待 10 秒。" : ""));

  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  function bridge(service: ServiceEditor) { return bridges.value.find((item) => item.id === service.profile.id); }
  function serviceActive(service: ServiceEditor) { return service.saved && service.profile.enabled && consent.value; }
  function serviceStatus(service: ServiceEditor) {
    return !service.saved ? "待保存" : !service.profile.enabled ? "已停用" : !consent.value ? "连接已暂停"
      : bridge(service)?.connected ? "已连接" : bridge(service)?.state === "connecting" ? "连接中" : "等待重连";
  }
  function serviceClass(service: ServiceEditor) {
    return !serviceActive(service) ? "" : bridge(service)?.connected ? "ok" : bridge(service)?.state === "connecting" ? "pending" : "bad";
  }
  function serviceUrl(service: ServiceEditor) {
    const profile = service.profile;
    const host = profile.host.includes(":") && !profile.host.startsWith("[") ? `[${profile.host}]` : profile.host;
    return `ws://${host}:${profile.port}`;
  }
  function serviceProgress(service: ServiceEditor) {
    if (!serviceActive(service)) return "";
    const item = bridge(service);
    const time = (value: number) => new Date(value).toLocaleTimeString();
    if (item?.connected) return item.connectedAt ? `连接于 ${time(item.connectedAt)}` : "连接正常";
    const next = item?.nextRetryAt ? ` · ${Math.max(0, Math.ceil((item.nextRetryAt - now.value) / 1000))} 秒后重试` : "";
    return `已尝试 ${item?.attempts ?? 0} 次${next}${item?.lastAttemptAt ? ` · 最近尝试 ${time(item.lastAttemptAt)}` : ""}`;
  }
  function editor(profile: BridgeProfile): ServiceEditor {
    return { profile: { ...profile }, draft: { ...profile }, saved: true, busy: false, retrying: false, error: "" };
  }
  async function refreshStatus() {
    const revision = ++statusRevision;
    try {
      const { bridgeConsent } = await chrome.storage.local.get("bridgeConsent");
      if (!active || revision !== statusRevision) return;
      consent.value = bridgeConsent === true;
      if (!consent.value) { bridges.value = []; statusError.value = ""; return; }
      const result = await chrome.runtime.sendMessage({ type: "bridgelens-get-status" });
      if (!active || revision !== statusRevision) return;
      if (!result) throw new Error("连接状态未知");
      bridges.value = result.bridges ?? [];
      statusError.value = "";
    } catch (error) { if (active && revision === statusRevision) statusError.value = errorText(error); }
  }
  async function saveService(service: ServiceEditor) {
    if (service.busy) return;
    service.busy = true;
    service.error = "";
    try {
      const profile = { ...service.draft, name: service.draft.name.trim() || "未命名服务", host: service.draft.host.trim(), token: service.draft.token.trim() };
      const profiles = await getBridgeProfiles();
      await setBridgeProfiles(profiles.some((item) => item.id === profile.id)
        ? profiles.map((item) => item.id === profile.id ? profile : item) : [...profiles, profile]);
      service.profile = profile;
      service.draft = { ...profile };
      service.saved = true;
      openServices.value = openServices.value.filter((id) => id !== profile.id);
      await refreshStatus();
    } catch (error) { service.error = errorText(error); }
    finally { service.busy = false; }
  }
  async function addService() {
    const profiles = withBridgeColors([...services.value.map((service) => service.profile), {
      id: crypto.randomUUID(), name: `服务 ${services.value.length + 1}`, host: DEFAULT_HOST, port: DEFAULT_PORT, token: "", enabled: true,
    }]);
    const service = editor(profiles.at(-1)!);
    service.saved = false;
    services.value.push(service);
    openServices.value.push(service.profile.id);
    await nextTick();
    document.querySelector<HTMLInputElement>(`[data-service-id="${service.profile.id}"] input[name="name"]`)?.focus();
  }
  function cancelService(service: ServiceEditor) {
    if (!service.saved) services.value = services.value.filter((item) => item !== service);
    else { service.draft = { ...service.profile }; service.error = ""; }
    openServices.value = openServices.value.filter((id) => id !== service.profile.id);
    document.getElementById("bl-add")?.focus();
  }
  async function deleteService(service: ServiceEditor) {
    if (service.busy) return;
    service.busy = true;
    try {
      await setBridgeProfiles((await getBridgeProfiles()).filter((item) => item.id !== service.profile.id));
      services.value = services.value.filter((item) => item !== service);
      openServices.value = openServices.value.filter((id) => id !== service.profile.id);
      document.getElementById("bl-add")?.focus();
      await refreshStatus();
    } catch (error) { service.error = errorText(error); }
    finally { service.busy = false; }
  }
  async function reconnect(service: ServiceEditor) {
    service.retrying = true;
    service.error = "";
    try {
      const result = await chrome.runtime.sendMessage({ type: "bridgelens-reconnect", id: service.profile.id });
      if (!result?.ok) throw new Error("无法重连，请确认服务已启用且已授权。");
      await refreshStatus();
    } catch (error) { service.error = errorText(error); }
    finally { service.retrying = false; }
  }
  async function setPreference(key: string, value: unknown) {
    changed.add(key);
    try { await chrome.storage.local.set({ [key]: value }); }
    catch (error) { statusError.value = errorText(error); }
  }
  function setDuration(value: number | undefined) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300) void setPreference("activityToastSeconds", value);
  }
  async function applyConsent() {
    await setPreference("bridgeConsent", consentDraft.value);
    consent.value = consentDraft.value;
    sections.value = consent.value ? sections.value.filter((name) => name !== "privacy") : [...new Set([...sections.value, "privacy"])];
    await refreshStatus();
  }
  async function refreshTabs() {
    if (targetBusy.value) return;
    const revision = ++tabsRevision;
    try {
      const [stored, local, allTabs, activeTabs] = await Promise.all([
        chrome.storage.session.get(["targetTabIds", "tabPolicies"]), chrome.storage.local.get("newTabPolicy"),
        chrome.tabs.query({}), chrome.tabs.query({ active: true, currentWindow: true }),
      ]);
      if (!active || targetBusy.value || revision !== tabsRevision) return;
      tabs.value = allTabs.filter((tab) => typeof tab.id === "number");
      targets.value = (Array.isArray(stored.targetTabIds) ? stored.targetTabIds as number[] : []).filter((id) => allTabs.some((tab) => tab.id === id));
      policies.value = stored.tabPolicies ?? {};
      globalPolicy.value = local.newTabPolicy === "follow" ? "follow" : "stay";
      activeTitle.value = activeTabs[0]?.title ?? "";
      targetMode.value = targets.value.length ? "pinned" : "current";
      targetPage.value = targets.value.length === 1 ? targets.value[0] : undefined;
    } catch (error) { pageError.value = errorText(error); }

  }
  async function setTargets(ids: number[]) {
    targetBusy.value = true;
    tabsRevision++;
    pageError.value = "";
    try { await chrome.storage.session.set({ targetTabIds: ids }); }
    catch (error) { pageError.value = errorText(error); }
    finally { targetBusy.value = false; await refreshTabs(); }
  }
  async function changeTargetMode(mode: string) {
    if (mode === "current") return setTargets([]);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id === "number") await setTargets([tab.id]);
    else pageError.value = "没有可固定的当前页面";
  }
  async function setPolicy(tabId: number, policy: Policy) {
    const { tabPolicies = {} } = await chrome.storage.session.get("tabPolicies");
    await chrome.storage.session.set({ tabPolicies: { ...tabPolicies, [tabId]: policy } });
    policies.value = { ...policies.value, [tabId]: policy };
  }
  function tabHost(tab: chrome.tabs.Tab) {
    try { return tab.url ? new URL(tab.url).host || tab.url : ""; } catch { return tab.url || ""; }
  }
  function applySetting(key: string, value: unknown) {
    if (key === "activityDisplayEnabled") settings.panel = value !== false;
    if (key === "activityToastEnabled") settings.toast = value !== false;
    if (key === "activityToastSeconds") settings.seconds = toastSeconds(value);
    if (key === "bridgeConsent") { consent.value = value === true; consentDraft.value = consent.value; }
  }
  function onStorage(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) { changed.add(key); applySetting(key, change.newValue); }
    if (changes.bridgeConsent) void refreshStatus();
  }
  function onMessage(message: { type?: string } & ActivitySnapshot) {
    if (message?.type === "bridgelens-activities") { activityRevision++; snapshot.value = message; }
  }
  onMounted(async () => {
    chrome.storage.onChanged.addListener(onStorage);
    chrome.runtime.onMessage.addListener(onMessage);
    const revision = activityRevision;
    void chrome.runtime.sendMessage({ type: "bridgelens-get-activities" }).then((result) => {
      if (active && revision === activityRevision && result) snapshot.value = result;
    }).catch(() => {});
    try {
      const keys = ["activityDisplayEnabled", "activityToastEnabled", "activityToastSeconds", "bridgeConsent"];
      const [stored, profiles] = await Promise.all([chrome.storage.local.get(keys), getBridgeProfiles()]);
      if (!active) return;
      for (const key of keys) if (!changed.has(key)) applySetting(key, stored[key]);
      services.value = profiles.map(editor);
      if (!consent.value) sections.value.push("privacy");
      await Promise.all([refreshStatus(), refreshTabs()]);
    } catch (error) { statusError.value = errorText(error); }
    finally { ready.value = true; }
    timers.push(setInterval(() => { now.value = Date.now(); void refreshStatus(); }, 1000), setInterval(refreshTabs, 2000));
  });
  onUnmounted(() => {
    active = false;
    timers.forEach(clearInterval);
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onMessage.removeListener(onMessage);
  });
  return { ready, settings, consent, consentDraft, sections, openServices, services, statusError, connectionHint, activityText, targetText,
    tabs, targets, policies, globalPolicy, targetBusy, targetMode, targetPage, BRIDGE_COLORS, bridge, serviceActive, serviceStatus,
    serviceClass, serviceUrl, serviceProgress, saveService, addService, cancelService, deleteService, reconnect, setPreference,
    setDuration, applyConsent, setTargets, changeTargetMode, setPolicy, tabHost };
}
