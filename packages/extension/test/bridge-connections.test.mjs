import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { BridgeConnections } = await load("../src/background/bridge-connections.ts");
const config = await load("../src/shared/config.ts");

class Socket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  sent = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(request) { return this.onmessage({ data: JSON.stringify(request) }); }
}
const profiles = [
  { id: "a", name: "Server A", host: "localhost", port: 19222, token: "a secret", enabled: true },
  { id: "b", name: "Server B", host: "192.168.1.2", port: 19222, token: "b", enabled: true },
];

test("multiple bridges route identical IDs, errors and out-of-order results to their own sockets", async (t) => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  Socket.instances = [];
  const pending = new Map();
  const manager = new BridgeConnections((request, source) => {
    assert.ok(!source.url.includes("secret"));
    return new Promise((resolve, reject) => pending.set(source.id, { resolve, reject }));
  });
  t.after(() => { manager.update([], false); globalThis.WebSocket = previous; });
  manager.update(profiles, true);
  const [a, b] = Socket.instances;
  assert.match(a.url, /token=a%20secret/);
  assert.equal(manager.status().length, 2);
  assert.equal(manager.status()[0].url, "ws://localhost:19222");
  const request = { id: "same-id", tool: "get_page_info", params: {} };
  const first = a.receive(request);
  const second = b.receive(request);
  pending.get("b").resolve({ title: "B" });
  await second;
  assert.deepEqual(a.sent, []);
  assert.deepEqual(b.sent, [{ id: "same-id", result: { title: "B" } }]);
  pending.get("a").reject(new Error("A failed"));
  await first;
  assert.deepEqual(a.sent, [{ id: "same-id", error: { message: "A failed" } }]);
  await a.receive({ t: "ping" });
  await a.onmessage({ data: "bad json" });
  await a.receive({ id: "bad", tool: "x", params: null });
  assert.equal(a.sent.length, 1);
  manager.update(profiles, true);
  assert.equal(Socket.instances.length, 2, "unchanged services keep their sockets");
  manager.update([{ ...profiles[0], token: "new-token" }, profiles[1]], true);
  assert.equal(a.readyState, 3, "changed credentials close the old connection");
  assert.equal(b.readyState, Socket.OPEN, "other service is unaffected");
  assert.match(Socket.instances[2].url, /token=new-token/);
  manager.update([{ ...profiles[0], enabled: false }, profiles[1]], true);
  assert.equal(Socket.instances[2].readyState, 3);
  assert.equal(manager.status().length, 1);
});

test("reconnect is independent; old replies cannot reach a replacement; consent closes every service", async (t) => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  Socket.instances = [];
  let finish;
  let signal;
  const manager = new BridgeConnections((_request, source) => {
    signal = source.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  t.after(() => { manager.update([], false); globalThis.WebSocket = previous; });
  manager.update(profiles, true);
  const [a, b] = Socket.instances;
  const pending = a.receive({ id: "old", tool: "execute_js", params: {} });
  a.close();
  assert.equal(signal.aborted, true);
  assert.equal(b.readyState, Socket.OPEN);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const replacement = Socket.instances[2];
  assert.equal(Socket.instances.length, 3);
  finish("old result");
  await pending;
  assert.deepEqual(replacement.sent, []);
  assert.deepEqual(b.sent, []);
  manager.update([profiles[1]], true);
  assert.equal(replacement.readyState, 3);
  assert.equal(b.readyState, Socket.OPEN);
  manager.update(profiles, false);
  assert.equal(b.readyState, 3);
  assert.deepEqual(manager.status(), []);
});

test("legacy config migration, empty list persistence and validation", async () => {
  const previous = globalThis.chrome;
  const storage = { bridgeHost: "10.0.0.8", bridgePort: 23456, bridgeToken: "legacy" };
  globalThis.chrome = { storage: { local: {
    async get() { return structuredClone(storage); },
    async set(values) { Object.assign(storage, structuredClone(values)); },
  } } };
  try {
    assert.deepEqual(await config.getBridgeProfiles(), [{
      id: "default", name: "默认服务", host: "10.0.0.8", port: 23456, token: "legacy", enabled: true,
    }]);
    await config.setBridgeProfiles(profiles);
    assert.deepEqual(await config.getBridgeProfiles(), profiles);
    await assert.rejects(config.setBridgeProfiles([profiles[0], { ...profiles[0], id: "duplicate-address" }]));
    await assert.rejects(config.setBridgeProfiles([{ ...profiles[0], port: 70000 }]));
    await assert.rejects(config.setBridgeProfiles([{ ...profiles[0], host: "ws://localhost" }]));
    await config.setBridgeProfiles([]);
    assert.deepEqual(await config.getBridgeProfiles(), []);
  } finally { globalThis.chrome = previous; }
});
