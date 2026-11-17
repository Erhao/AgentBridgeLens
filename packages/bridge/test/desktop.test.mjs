import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const entry = process.env.ABL_BRIDGE_ENTRY || fileURLToPath(new URL("../dist/index.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/desktop-worker.py", import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BRIDGELENS_")));
async function port() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(value);
}
async function stdio(t, extra = {}) {
  const client = new Client({ name: "desktop-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { ...baseEnv, BRIDGELENS_PORT: await port(), ...extra }, stderr: "pipe" }));
  return client;
}
const parse = (result) => JSON.parse(result.content[0].text);
const fixtureEnv = { BRIDGELENS_DESKTOP: "1", BRIDGELENS_LINUX_AGENT: fixture };

test("desktop tools are opt-in; browser tools remain available", { timeout: 10000 }, async (t) => {
  const client = await stdio(t);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(({ name }) => name === "capture_screenshot"));
  assert.ok(tools.every(({ name }) => !name.startsWith("desktop_")));
});

test("desktop MCP returns images, validates schemas, and survives executor failure without retrying actions", { timeout: 15000, skip: process.platform !== "linux" }, async (t) => {
  const client = await stdio(t, fixtureEnv);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.filter(({ name }) => name.startsWith("desktop_")).length, 9);
  const caps = parse(await client.callTool({ name: "desktop_get_capabilities", arguments: {} }));
  const browser = await client.callTool({ name: "get_page_info", arguments: {} });
  assert.equal(browser.isError, true);
  assert.match(browser.content[0].text, /Chrome extension not connected/);
  const image = await client.callTool({ name: "desktop_capture_screenshot", arguments: { sessionId: caps.sessionId } });
  assert.equal(image.content[1].type, "image");
  assert.equal(image.content[1].mimeType, "image/png");
  assert.equal(parse(image).screenshot.width, 1);
  assert.equal(parse(image).screenshot.data, undefined);
  assert.equal((await client.callTool({ name: "desktop_observe", arguments: { sessionId: caps.sessionId, windowId: "w", maxNodes: 1001 } })).isError, true);
  for (const target of ["crash", "invalid-json"]) {
    const result = await client.callTool({ name: "desktop_act", arguments: { sessionId: caps.sessionId, action: "invoke", target } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exited|invalid JSON/);
    const restarted = parse(await client.callTool({ name: "desktop_get_capabilities", arguments: {} }));
    assert.notEqual(restarted.sessionId, caps.sessionId);
  }
});

test("missing Python produces an actionable MCP error without breaking browser MCP", { timeout: 10000, skip: process.platform !== "linux" }, async (t) => {
  const client = await stdio(t, { ...fixtureEnv, BRIDGELENS_PYTHON: "/missing/desktop-python" });
  const result = await client.callTool({ name: "desktop_get_capabilities", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cannot start desktop Python/);
  assert.ok((await client.listTools()).tools.some(({ name }) => name === "get_page_info"));
});

test("actual packaged Python worker diagnoses a headless session and rejects stale sessions", { timeout: 10000, skip: process.platform !== "linux" }, async (t) => {
  const client = await stdio(t, { BRIDGELENS_DESKTOP: "1", DISPLAY: "", WAYLAND_DISPLAY: "" });
  const caps = parse(await client.callTool({ name: "desktop_get_capabilities", arguments: {} }));
  assert.equal(caps.graphicalSession, false);
  assert.equal(caps.portal.active, false);
  const stale = await client.callTool({ name: "desktop_list_apps", arguments: { sessionId: "old-session" } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE_SESSION/);
  const headless = await client.callTool({ name: "desktop_list_apps", arguments: { sessionId: caps.sessionId } });
  assert.equal(headless.isError, true);
  assert.match(headless.content[0].text, /NO_DESKTOP/);
  assert.equal(parse(await client.callTool({ name: "desktop_stop", arguments: {} })).sharingClosed, true);
});

test("HTTP clients share one executor; a second client can cancel a pending call", { timeout: 15000, skip: process.platform !== "linux" }, async (t) => {
  const httpPort = await port();
  const child = spawn(process.execPath, [entry], { env: { ...baseEnv, ...fixtureEnv,
    BRIDGELENS_TRANSPORT: "http", BRIDGELENS_PORT: await port(), BRIDGELENS_HTTP_PORT: httpPort },
    stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => { if (String(chunk).includes("MCP Streamable HTTP listening")) resolve(); });
    child.once("exit", (code) => reject(new Error(`Bridge exited ${code}`)));
  });
  const clients = await Promise.all([1, 2].map(async () => {
    const client = new Client({ name: "desktop-http", version: "1" });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`)));
    return client;
  }));
  const caps = await Promise.all(clients.map((client) => client.callTool({ name: "desktop_get_capabilities", arguments: {} }).then(parse)));
  assert.equal(caps[0].sessionId, caps[1].sessionId);
  const pending = clients[0].callTool({ name: "desktop_wait_for", arguments: { sessionId: caps[0].sessionId, windowId: "w", name: "future" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(parse(await clients[1].callTool({ name: "desktop_stop", arguments: {} })).stopped, true);
  const stopped = await pending;
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /CANCELLED/);
  // A saturated ordinary queue still has a reserved slot for emergency stop.
  const saturated = Array.from({ length: 32 }, () => clients[0].callTool({
    name: "desktop_wait_for", arguments: { sessionId: caps[0].sessionId, windowId: "w", name: "never" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const full = await clients[1].callTool({ name: "desktop_get_capabilities", arguments: {} });
  assert.equal(full.isError, true);
  assert.match(full.content[0].text, /queue is full/);
  assert.equal(parse(await clients[1].callTool({ name: "desktop_stop", arguments: {} })).stopped, true);
  assert.ok((await Promise.all(saturated)).every((result) => result.isError));
  await Promise.all(clients.map((client) => client.close()));
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  // Shutdown owns the worker lifecycle; no orphan Python process.
  assert.throws(() => process.kill(Number(caps[0].sessionId), 0), /ESRCH/);
});
