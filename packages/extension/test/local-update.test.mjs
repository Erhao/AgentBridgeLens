import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/background/local-update.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { startLocalUpdateChecks, LOCAL_UPDATE_ALARM } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const running = { manifest_version: 3, name: "AgentBridgeLens", version: "1.1.0" };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, existingAlarm) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => { globalThis.chrome = previous.chrome; globalThis.fetch = previous.fetch; });
  const state = { busy: false, reloads: 0, created: [], requests: [], listeners: [], disk: { ...running }, existingAlarm };
  globalThis.chrome = {
    runtime: { getManifest: () => running, getURL: path => `chrome-extension://local-id/${path}`, reload: () => state.reloads++ },
    alarms: {
      get: async () => state.existingAlarm,
      create: async (...args) => { state.created.push(args); },
      onAlarm: { addListener: listener => state.listeners.push(listener) },
    },
  };
  globalThis.fetch = async (...args) => {
    state.requests.push(args);
    if (state.fetchOverride) return state.fetchOverride();
    return new Response(JSON.stringify(state.disk));
  };
  startLocalUpdateChecks(() => state.busy);
  await flush();
  state.tick = async (name = LOCAL_UPDATE_ALARM) => {
    for (const listener of state.listeners) listener({ name });
    await flush();
  };
  return state;
}

test("one-minute alarm is registered once without resetting an existing deadline", async t => {
  const state = await fixture(t);
  assert.deepEqual(state.created, [[LOCAL_UPDATE_ALARM, { periodInMinutes: 1 }]]);
  await state.tick("bridgelens-keepalive");
  assert.equal(state.requests.length, 0);
  state.created.length = 0;
  state.existingAlarm = { name: LOCAL_UPDATE_ALARM, periodInMinutes: 1 };
  startLocalUpdateChecks(() => state.busy);
  await flush();
  assert.deepEqual(state.created, []);
});

test("reads only its own directory without cache, skips unchanged version and activates upgrades and rollbacks", async t => {
  const state = await fixture(t);
  await state.tick();
  assert.equal(state.reloads, 0);
  state.disk.version = "1.2.0";
  await state.tick();
  state.disk.version = "1.0.0";
  await state.tick();
  assert.equal(state.reloads, 2);
  for (const [url, options] of state.requests) {
    assert.match(url, /^chrome-extension:\/\/local-id\/manifest\.json\?local-update=/);
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(new Set(state.requests.map(([url]) => url)).size, state.requests.length);
});

test("unreadable, incomplete or unrelated manifests never reload, and the next alarm retries", async t => {
  const state = await fixture(t);
  for (const disk of [null, {}, { ...running, version: "broken" }, { ...running, version: "65536.0" },
    { ...running, version: "0.0.0" }, { ...running, version: "1.2.0", name: "Other" },
    { ...running, version: "1.2.0", key: "different identity" }, { ...running, version: "1.2.0", manifest_version: 2 }]) {
    state.disk = disk;
    await state.tick();
  }
  for (const response of [() => new Response("missing", { status: 404 }), () => new Response("{unfinished"),
    () => { throw new Error("directory is being switched"); }]) {
    state.fetchOverride = response;
    await state.tick();
  }
  assert.equal(state.reloads, 0);
  state.fetchOverride = undefined;
  state.disk = { ...running, version: "1.2.0" };
  await state.tick();
  assert.equal(state.reloads, 1);
});

test("defers during work, prevents overlapping reads, and rechecks work after fetching", async t => {
  const state = await fixture(t);
  state.disk.version = "1.2.0";
  state.busy = true;
  await state.tick();
  assert.equal(state.requests.length, 0);
  state.busy = false;
  let finish;
  state.fetchOverride = () => new Promise(resolve => { finish = resolve; });
  await state.tick();
  await state.tick();
  assert.equal(state.requests.length, 1);
  state.busy = true;
  finish(new Response(JSON.stringify(state.disk)));
  await flush();
  assert.equal(state.reloads, 0);
  state.busy = false;
  state.fetchOverride = undefined;
  await state.tick();
  assert.equal(state.reloads, 1);
});
