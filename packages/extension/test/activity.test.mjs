import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function moduleFrom(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { summarizeActivityResult } = await moduleFrom(await readFile(new URL("../src/shared/activity-summary.ts", import.meta.url), "utf8"));
const activitySource = await readFile(new URL("../src/shared/activity.ts", import.meta.url), "utf8");
const { describeActivity, formatActivity, formatActivityCard, visibleActivities, ActivityToastState, activitiesForWindow } = await moduleFrom(activitySource);

test("activity describes data dimensions and filters without copying payloads", () => {
  assert.deepEqual(describeActivity("inspect_element", { selector: "#submit" }), {
    dimension: "元素与样式", scope: "元素：#submit", action: "检查目标元素的属性、样式与位置",
  });
  const network = describeActivity("get_cdp_network", { status: 500, urlPattern: "token=secret" });
  assert.match(network.scope, /状态码：500/);
  assert.ok(!JSON.stringify(network).includes("secret"));
  assert.deepEqual(describeActivity("execute_js", { code: "private source", token: "secret" }), {
    dimension: "页面脚本", scope: "", action: "执行页面脚本",
  });
  assert.ok(describeActivity("future_tool", {}).dimension);
});

test("formatting distinguishes current work, failed work and browser-wide operations", () => {
  const item = { tool: "inspect_element", dimension: "元素与样式", scope: "元素：#submit", bridgeName: "开发机", state: "running", startedAt: 1000, tabId: 3, page: "设置页" };
  assert.match(formatActivity(item), /正在执行.*元素与样式/);
  assert.match(formatActivity(item), /设置页（标签页 3）/);
  assert.match(formatActivity({ ...item, state: "failed", finishedAt: 2500 }), /执行失败.*1.5 秒/);
  assert.match(formatActivity({ ...item, tabId: undefined }), /范围：浏览器管理/);
});

test("worker tracks overlapping calls, actual target tabs, completion and resolution errors", async () => {
  const originalChrome = globalThis.chrome;
  let handle;
  let resolveTab;
  const events = [];
  const pageEvents = [];
  const listeners = [];
  const noopEvent = { addListener() {} };
  const dependencies = {
    describeActivity, activitiesForWindow, summarizeActivityResult,
    BRIDGE_COLORS: ["#60a5fa"],
    ContentConnection: class {
      async ensure() {}
      forget() {}
      async sendActivity(tabId, message) { return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
    },
    BridgeConnections: class {
      constructor(callback) { handle = callback; }
      update() {}
    },
    getBridgeProfiles: async () => [],
    resolveTabId: async (id) => { if (id === -1) throw new Error("No target"); return id ?? 42; },
    listTabs: () => new Promise((resolve) => { resolveTab = resolve; }),
    getCdpNetwork: async () => ({ requests: [] }),
    registerTabListeners() {},
  };
  globalThis.__activityDependencies = dependencies;
  globalThis.chrome = {
    storage: { local: { get: async () => ({}) }, onChanged: noopEvent },
    runtime: {
      sendMessage: async (event) => { events.push(structuredClone(event)); },
      onMessage: { addListener(listener) { listeners.push(listener); }, removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } }, onInstalled: noopEvent,
    },
    tabs: {
      onRemoved: noopEvent, onAttached: noopEvent,
      query: async () => [{ id: 42, windowId: 1 }, { id: 43, windowId: 2 }],
      sendMessage: async (id, message, options) => {
        pageEvents.push({ id, message: structuredClone(message), options });
        if (message.type === "bridgelens-request") throw new Error("No receiving content script");
        if (id === 43) throw new Error("No content script");
      },
      get: async (id) => ({ id, windowId: 1, title: "实际目标", url: "https://example.com/path?token=secret" }),
    },
    alarms: { create() {}, onAlarm: noopEvent },
  };
  try {
    let source = await readFile(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
    source = source.replace(/import[\s\S]*?from\s+"[^"]+";/g, "");
    source = `const { ${Object.keys(dependencies).join(", ")} } = globalThis.__activityDependencies;\n${source}`;
    await moduleFrom(source);
    const bridge = { name: "开发机" };
    const pending = handle({ tool: "list_tabs", params: {} }, bridge);
    await handle({ tool: "get_cdp_network", params: { status: 500 } }, bridge);
    const latest = events.at(-1);
    assert.equal(latest.active.length, 1, "first call remains running when second finishes");
    assert.equal(latest.last.tabId, 42);
    assert.equal(latest.last.windowId, 1);
    assert.equal(latest.last.page, "实际目标");
    assert.equal(latest.last.site, "https://example.com");
    assert.equal(latest.last.state, "completed");
    assert.match(latest.last.outcome, /0 条网络记录/);
    assert.ok(pageEvents.some((event) => event.id === 42 && event.message.last?.tabId === 42), "activity reaches web pages without opening a panel");
    assert.ok(pageEvents.every((event) => event.options.frameId === 0), "only the top frame displays automatic prompts");
    let snapshot;
    listeners[0]({ type: "bridgelens-get-activities" }, {}, (result) => { snapshot = result; });
    assert.equal(snapshot.active.length, 1, "reopened panels can fetch current activity");
    assert.equal(snapshot.recent.length, 1, "completed cards remain alongside running cards");
    assert.ok(pageEvents.filter((event) => event.id === 43).every((event) => !event.message.last && event.message.active.length === 0 && event.message.recent.length === 0), "other windows never receive unrelated operation data");
    let scoped;
    listeners[0]({ type: "bridgelens-get-activities" }, { tab: { id: 43, windowId: 2 }, url: "https://other.example/" }, (result) => { scoped = result; });
    assert.equal(scoped.windowId, 2);
    assert.equal(scoped.active.length, 0);
    assert.equal(scoped.recent.length, 0);
    resolveTab([]);
    await pending;
    assert.equal(events.at(-1).active.length, 0);
    await assert.rejects(handle({ tool: "get_cdp_network", params: { tabId: -1 } }, bridge), /No target/);
    assert.equal(events.at(-1).last.state, "failed");
    assert.equal(events.at(-1).recent.length, 3, "snapshots preserve rapid completions instead of replacing the previous card");
    const listenerCount = listeners.length;
    await assert.rejects(handle({ tool: "get_page_info", params: {} }, bridge), /No receiving content script/);
    assert.equal(listeners.length, listenerCount, "failed sends remove temporary response listeners immediately");
    assert.equal(events.at(-1).active.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
    delete globalThis.__activityDependencies;
  }
});

test("toast cards are deduplicated, independently expire and stay in creation order", () => {
  const base = { tool: "get_page_info", dimension: "页面信息", scope: "", bridgeName: "服务", state: "completed" };
  const first = { ...base, id: "a", startedAt: 1000, finishedAt: 2000, sequence: 1 };
  const second = { ...base, id: "b", startedAt: 1000, finishedAt: 1500, sequence: 2 };
  const running = { ...base, id: "c", startedAt: 1200, state: "running" };
  const snapshot = { recent: [second, first], last: first, active: [running] };
  assert.deepEqual(visibleActivities(snapshot, 2, 2500).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(visibleActivities(snapshot, 2, 3500).map((item) => item.id), ["a", "c"]);
  assert.deepEqual(visibleActivities(snapshot, 2, 4000).map((item) => item.id), ["c"]);
  assert.deepEqual(visibleActivities(snapshot, 0, 2500).map((item) => item.id), ["c"]);
  assert.deepEqual(visibleActivities(snapshot, 5, 5000).map((item) => item.id), ["a", "b", "c"]);
  const duplicate = { ...first, state: "running", finishedAt: undefined };
  assert.equal(visibleActivities({ recent: [first], active: [duplicate] }, 2, 9000)[0].state, "running");
});

test("hover pins survive expiry and history eviction; closing a call stays local", () => {
  const state = new ActivityToastState();
  const first = { id: "first", tool: "get_page_info", dimension: "页面信息", scope: "", bridgeName: "A", state: "running", startedAt: 1000 };
  state.update({ active: [first] });
  state.pin("first");
  const finished = { ...first, state: "completed", finishedAt: 2000 };
  state.update({ active: [], recent: [finished] });
  assert.equal(state.visible(2, 9000)[0].state, "completed", "pinned live content continues to update");
  state.update({ active: [], recent: [] });
  assert.equal(state.visible(2, 999999).length, 1, "server history eviction cannot unpin a card");
  state.dismiss("first");
  assert.equal(state.visible(2, 999999).length, 0);
  const other = { ...first, id: "other", startedAt: 3000 };
  state.update({ active: [first, other] });
  state.dismiss("first");
  state.update({ active: [other], recent: [{ ...finished, finishedAt: 10000 }] });
  assert.deepEqual(state.visible(2, 10001).map((item) => item.id), ["other"], "dismissed calls do not return on new updates");
  state.pin("other"); state.resetInteraction();
  state.update({ active: [] });
  assert.equal(state.visible(2, 999999).length, 0, "disabling the overlay clears pinned cards");
});

test("window scoping excludes unresolved and browser-wide actions while preserving that window's last action", () => {
  const first = { id: "a", windowId: 1, startedAt: 1, state: "completed", finishedAt: 5 };
  const second = { id: "b", windowId: 2, startedAt: 2, state: "completed", finishedAt: 6 };
  const pending = { id: "pending", state: "running", startedAt: 3 };
  const snapshot = { active: [pending, { ...first, state: "running" }], recent: [first, second], last: second, revision: 9 };
  const scoped = activitiesForWindow(snapshot, 1);
  assert.deepEqual(scoped.active.map((a) => a.id), ["a"]);
  assert.deepEqual(scoped.recent.map((a) => a.id), ["a"]);
  assert.equal(scoped.last.id, "a");
  assert.equal(scoped.windowId, 1);
  assert.equal(scoped.revision, 9);
  assert.equal(activitiesForWindow(snapshot, 3).last, undefined);
  assert.equal(activitiesForWindow(snapshot, undefined).active.length, 0, "missing recipient window fails closed");
});

test("moving viewers or running targets clears pinned cards outside the receiving window", () => {
  const state = new ActivityToastState();
  const action = { id: "a", windowId: 1, state: "running", startedAt: 1 };
  state.update({ active: [action], windowId: 1 }); state.pin("a");
  state.update({ active: [], windowId: 2 });
  assert.equal(state.visible(2).length, 0, "viewer moved into an unrelated window");
  state.update({ active: [action], windowId: 1 }); state.pin("a");
  state.update({ active: [], windowId: 1 });
  assert.equal(state.visible(2).length, 0, "running target moved to a different window");
});

test("script descriptions are optional, bounded, and clearly attributed to AI", () => {
  const described = describeActivity("execute_js", { code: "private script", activity: "读取筛选条件和列表行数，排查列表为空" });
  assert.equal(described.aiDescription, "读取筛选条件和列表行数，排查列表为空");
  const card = formatActivityCard({ id: "script", tool: "execute_js", ...described, bridgeName: "N100", state: "completed", startedAt: 1, finishedAt: 2, outcome: "脚本返回：行数 0" });
  assert.match(card, /AI 说明：读取筛选条件/);
  assert.match(card, /结果：脚本返回：行数 0/);
  assert.ok(!card.includes("private script"));
  assert.ok(!card.includes("工具："));
  assert.equal(describeActivity("execute_js", { activity: "长".repeat(200) }).aiDescription.length, 80);
  assert.equal(describeActivity("inspect_element", { activity: "ignored" }).aiDescription, undefined);
  assert.ok(!describeActivity("inspect_element", { selector: 'input[value="private-value"]' }).scope.includes("private-value"));
  assert.ok(!describeActivity("execute_js", { activity: '检查按钮 token="private long value"' }).aiDescription.includes("private"));
  const filtered = describeActivity("get_network_requests", { urlPattern: "https://user:pass@example.com/api/items?token=private", status: 500 });
  assert.match(filtered.scope, /https:\/\/example.com\/api\/items/);
  assert.ok(!filtered.scope.includes("private") && !filtered.scope.includes("pass"));
});

test("local result summaries report actual counts without exposing script values or payloads", () => {
  assert.equal(summarizeActivityResult("execute_js", { value: { rowCount: 0, token: "private", body: "sensitive" } }), "脚本返回：行数 0");
  assert.equal(summarizeActivityResult("execute_js", { value: ["private", "private"] }), "脚本返回 2 个条目");
  assert.ok(!summarizeActivityResult("execute_js", { value: "private" }).includes("private"));
  assert.ok(!summarizeActivityResult("execute_js", { value: { password: "private" } }).includes("private"));
  assert.match(summarizeActivityResult("get_cdp_network", { requests: [{ status: 200 }, { status: 500, body: "private" }, { failed: "private" }] }), /3 条网络记录，其中 2 条异常或失败（HTTP 500）/);
  assert.equal(summarizeActivityResult("get_errors", [{ level: "error", message: "private" }]), "读取到 1 条错误记录");
  assert.equal(summarizeActivityResult("get_dom_snapshot", { tag: "body", children: [{ tag: "button", text: "private" }] }), "返回页面结构，含 2 个节点");
  assert.match(summarizeActivityResult("inspect_element", { boundingBox: { width: 80, height: 20 }, attributes: { disabled: "" } }), /80 × 20 px；存在 disabled 属性/);
  assert.equal(summarizeActivityResult("replay_actions", { replayed: 1, total: 3 }), "实际回放 1/3 步");
  assert.equal(summarizeActivityResult("execute_js", { error: "ReferenceError: private secret" }), "脚本执行发生 ReferenceError");
  assert.equal(summarizeActivityResult("inspect_element", { error: "Element not found: private selector" }), "未找到目标元素");
  assert.equal(summarizeActivityResult("execute_js", { error: "private secret" }), "页面脚本执行出错");
});
