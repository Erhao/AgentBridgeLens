import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BRIDGELENS_")));
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Streamable HTTP: SDK clients, concurrent calls, extension relay and HTTP validation", { timeout: 20000 }, async (t) => {
  const wsPort = await freePort();
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...baseEnv, BRIDGELENS_TRANSPORT: "http", BRIDGELENS_PORT: String(wsPort),
      BRIDGELENS_HTTP_PORT: String(port), BRIDGELENS_HTTP_TOKEN: "test-token",
      BRIDGELENS_HTTP_ALLOWED_ORIGINS: "https://allowed.example" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      if (log.includes("MCP Streamable HTTP listening")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`Server exited (${code}): ${log}`)));
  });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const headers = { Authorization: "Bearer test-token" };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://allowed.example" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://allowed.example");
  for (const method of ["GET", "DELETE", "PUT"]) {
    assert.equal((await fetch(url, { method, headers })).status, 405);
  }
  assert.equal((await fetch(new URL("/missing", url), { headers })).status, 404);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{" })).status, 400);

  const clients = await Promise.all([1, 2].map(async (i) => {
    const client = new Client({ name: `test-${i}`, version: "1.0" });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_page_info"));
    return client;
  }));
  const missing = await clients[0].callTool({ name: "get_page_info", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not connected/);

  // Simulate the browser extension on its real WebSocket protocol.
  const extension = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  t.after(() => extension.terminate());
  extension.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.t === "ping") return;
    const reply = request.tool === "capture_screenshot"
      ? { dataUrl: "data:image/png;base64,aGVsbG8=" }
      : { tabId: request.params.tabId, title: "Test page" };
    // Reversed response order exercises request correlation across clients.
    setTimeout(() => extension.send(JSON.stringify({ id: request.id, result: reply })), request.params.tabId === 11 ? 40 : 1);
  });
  await once(extension, "open");
  const results = await Promise.all(clients.map((client, i) => client.callTool({
    name: "get_page_info", arguments: { tabId: i === 0 ? 11 : 22 },
  })));
  assert.equal(JSON.parse(results[0].content[0].text).tabId, 11);
  assert.equal(JSON.parse(results[1].content[0].text).tabId, 22);
  const screenshot = await clients[0].callTool({ name: "capture_screenshot", arguments: {} });
  assert.deepEqual(screenshot.content[0], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  await Promise.all(clients.map((client) => client.close()));
  extension.close();
  await once(extension, "close");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
});

test("default stdio still initializes and lists tools", { timeout: 10000 }, async (t) => {
  const client = new Client({ name: "stdio-test", version: "1.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { ...baseEnv, BRIDGELENS_PORT: String(await freePort()) }, stderr: "pipe" }));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "capture_screenshot"));
});

test("HTTP refuses a non-loopback listener without authentication", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [entry], { env: { ...baseEnv,
    BRIDGELENS_TRANSPORT: "http", BRIDGELENS_HTTP_HOST: "0.0.0.0" }, stdio: "ignore" });
  assert.notEqual((await once(child, "exit"))[0], 0);
});
