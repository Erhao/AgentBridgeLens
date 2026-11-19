import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";

const entry = process.env.ABL_BRIDGE_ENTRY ?? fileURLToPath(new URL("../dist/index.js", import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BRIDGELENS_")));
const nativeToken = "remote-test-token-0123456789abcdef";
const httpToken = "http-test-token-0123456789abcdef";
const browserToken = "browser-test-token-0123456789abcdef";

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return String(port);
}

function upgradeStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
  });
}

test("remote Mac and Chrome share a Bridge while tokens and control remain separate", { timeout: 15000 }, async (t) => {
  const wsPort = await freePort();
  const macPort = await freePort();
  const httpPort = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...baseEnv, BRIDGELENS_TRANSPORT: "http", BRIDGELENS_PORT: wsPort,
      BRIDGELENS_MAC_PORT: macPort, BRIDGELENS_HTTP_PORT: httpPort,
      BRIDGELENS_MAC_REMOTE_TOKEN: nativeToken, BRIDGELENS_HTTP_TOKEN: httpToken,
      BRIDGELENS_TOKEN: browserToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      if (log.includes("MCP Streamable HTTP listening")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`Bridge exited (${code}): ${log}`)));
  });

  const macURL = `ws://127.0.0.1:${macPort}/native`;
  assert.equal(await upgradeStatus(macURL, {}), 401);
  for (const token of [browserToken, httpToken]) {
    assert.equal(await upgradeStatus(macURL, { Authorization: `Bearer ${token}` }), 401);
  }
  const nativeHeaders = { Authorization: `Bearer ${nativeToken}` };
  assert.equal(await upgradeStatus(macURL, { ...nativeHeaders, Origin: "https://browser.example" }), 401);

  const native = new WebSocket(macURL, { headers: nativeHeaders });
  t.after(() => native.terminate());
  await once(native, "open");
  const ack = once(native, "message");
  native.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "fixture-mac", version: "0.4.0", capabilities: [] }));
  assert.equal(JSON.parse((await ack)[0]).type, "hello_ack");
  assert.equal(await upgradeStatus(macURL, nativeHeaders), 409);
  native.on("message", (raw) => {
    const message = JSON.parse(raw);
    assert.ok(["mac_get_status", "mac_list_windows", "mac_stop"].includes(message.tool));
    const result = {
      mac_get_status: { controlEnabled: false, permissions: { accessibility: true, screenCapture: true } },
      mac_list_windows: { windows: [{ windowRef: "w1", title: "Fixture", pid: 42 }] },
      mac_stop: { stopped: true },
    }[message.tool];
    native.send(JSON.stringify({ type: "response", id: message.id, result }));
  });

  const url = new URL(`http://127.0.0.1:${httpPort}/mcp`);
  assert.equal((await fetch(url, { headers: nativeHeaders })).status, 401);
  const client = new Client({ name: "remote-mac-test", version: "1.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${httpToken}` } },
  }));
  const { tools } = await client.listTools();
  assert.equal(tools.filter((tool) => tool.name.startsWith("desktop_")).length, 9);
  assert.equal(tools.some((tool) => tool.name.startsWith("mac_")), false);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const parse = (result) => JSON.parse(result.content[0].text);
  const caps = parse(await call("desktop_get_capabilities"));
  assert.equal(caps.platform, "darwin");
  assert.equal(caps.connected, true);
  const windows = parse(await call("desktop_list_windows", { sessionId: caps.sessionId }));
  assert.equal(windows.windows[0].windowId, "w1");
  const denied = await call("desktop_start_session", { sessionId: caps.sessionId, windowId: "w1", input: true });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /CONTROL_DISABLED/);
  assert.equal(parse(await call("desktop_stop")).stopped, true);

  const browser = new WebSocket(`ws://127.0.0.1:${wsPort}/?token=${browserToken}`);
  t.after(() => browser.terminate());
  browser.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.tool === "get_page_info") {
      browser.send(JSON.stringify({ id: message.id, result: { title: "Browser remains connected" } }));
    }
  });
  await once(browser, "open");
  assert.equal(parse(await call("get_page_info")).title, "Browser remains connected");
});

test("remote Mac HTTP mode refuses a missing HTTP token or reused native token", { timeout: 10000 }, async () => {
  for (const credentials of [{}, { BRIDGELENS_HTTP_TOKEN: nativeToken }, { BRIDGELENS_HTTP_TOKEN: httpToken, BRIDGELENS_MAC_REMOTE_TOKEN: "" }]) {
    const child = spawn(process.execPath, [entry], {
      env: { ...baseEnv, BRIDGELENS_TRANSPORT: "http", BRIDGELENS_MAC_REMOTE_TOKEN: nativeToken, ...credentials },
      stdio: "ignore",
    });
    assert.notEqual((await once(child, "exit"))[0], 0);
  }
});
