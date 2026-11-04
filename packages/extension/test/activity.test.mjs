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
const activitySource = await readFile(new URL("../src/shared/activity.ts", import.meta.url), "utf8");
const { describeActivity, formatActivity } = await moduleFrom(activitySource);

test("activity describes data dimensions and filters without copying payloads", () => {
  assert.deepEqual(describeActivity("inspect_element", { selector: "#submit" }), {
    dimension: "元素与样式", scope: "元素：#submit",
  });
  const network = describeActivity("get_cdp_network", { status: 500, urlPattern: "token=secret" });
  assert.match(network.scope, /状态码：500/);
  assert.ok(!JSON.stringify(network).includes("secret"));
  assert.deepEqual(describeActivity("execute_js", { code: "private source", token: "secret" }), {
    dimension: "页面脚本", scope: "",
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
  const listeners = [];
  const noopEvent = { addListener() {} };
  const dependencies = {
    describeActivity,
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
      onMessage: { addListener(listener) { listeners.push(listener); } }, onInstalled: noopEvent,
    },
    tabs: { get: async (id) => ({ id, title: "实际目标", url: "https://example.com/path?token=secret" }) },
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
    assert.equal(latest.last.page, "实际目标");
    assert.equal(latest.last.site, "https://example.com");
    assert.equal(latest.last.state, "completed");
    let snapshot;
    listeners[0]({ type: "bridgelens-get-activities" }, {}, (result) => { snapshot = result; });
    assert.equal(snapshot.active.length, 1, "reopened panels can fetch current activity");
    resolveTab([]);
    await pending;
    assert.equal(events.at(-1).active.length, 0);
    await assert.rejects(handle({ tool: "get_cdp_network", params: { tabId: -1 } }, bridge), /No target/);
    assert.equal(events.at(-1).last.state, "failed");
    assert.equal(events.at(-1).active.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
    delete globalThis.__activityDependencies;
  }
});
