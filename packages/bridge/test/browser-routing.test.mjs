import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";

const entry = process.env.ABL_BRIDGE_ENTRY || fileURLToPath(new URL("../dist/index.js", import.meta.url));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BRIDGELENS_")));
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const value = result => JSON.parse(result.content[0].text);

test("registered browsers: concurrent MCP routing, session binding, spoofed replies, disconnect and reconnect", { timeout: 20000 }, async t => {
  const [port, wsPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(process.execPath, [entry], { env: { ...cleanEnv,
    BRIDGELENS_TRANSPORT: "http", BRIDGELENS_HTTP_PORT: String(port), BRIDGELENS_PORT: String(wsPort),
  }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", chunk => { log += chunk; if (log.includes("MCP Streamable HTTP listening")) resolve(); });
    child.once("exit", code => reject(new Error(`Server exited ${code}: ${log}`)));
  });
  async function client(browserId) {
    const client = new Client({ name: "routing-test", version: "1" });
    t.after(() => client.close());
    const query = browserId ? `?browserId=${browserId}` : "";
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp${query}`)));
    return client;
  }
  const ids = [randomUUID(), randomUUID()];
  const seen = [[], []];
  let hold;
  let held;
  async function extension(browserId, index) {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    t.after(() => socket.terminate());
    await once(socket, "open");
    const ack = once(socket, "message");
    socket.send(JSON.stringify({ t: "register_browser", protocolVersion: 2, browserId, name: `Chrome ${index}` }));
    assert.equal(JSON.parse(String((await ack)[0])).browserId, browserId);
    socket.on("message", raw => {
      const request = JSON.parse(String(raw));
      if (request.t) return;
      seen[index].push(request);
      if (hold && index === 0) { held(request); return; }
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id,
          result: request.tool === "capture_screenshot" ? { dataUrl: "data:image/png;base64,aGVsbG8=" } : { browserId, tabId: request.params.tabId },
        }));
      }, index === 0 ? 30 : 1);
    });
    return socket;
  }
  const [a, b] = [await extension(ids[0], 0), await extension(ids[1], 1)];
  const [unbound, ca, cb] = await Promise.all([client(), client(ids[0]), client(ids[1])]);
  const listed = value(await unbound.callTool({ name: "list_browsers", arguments: {} }));
  assert.equal(listed.filter(x => x.registered && x.connected).length, 2);
  const ambiguous = await unbound.callTool({ name: "get_page_info", arguments: {} });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /browserId/);
  const results = await Promise.all([ca, cb].map(c => c.callTool({ name: "get_page_info", arguments: { tabId: 7 } })));
  assert.deepEqual(results.map(r => value(r).browserId), ids, "identical tab IDs never cross browsers");
  assert.ok(!("browserId" in seen[0][0].params), "routing metadata is not forwarded as page arguments");
  assert.equal(value(await unbound.callTool({ name: "get_page_info", arguments: { browserId: ids[1], tabId: 7 } })).browserId, ids[1]);
  const conflict = await ca.callTool({ name: "get_page_info", arguments: { browserId: ids[1] } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /conflicts/);
  const screenshot = await cb.callTool({ name: "capture_screenshot", arguments: { tabId: 7 } });
  assert.equal(screenshot.content[0].type, "image");

  // A second live connection claiming A's ID must not evict A.
  const duplicate = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  t.after(() => duplicate.terminate());
  await once(duplicate, "open");
  const rejected = once(duplicate, "close");
  duplicate.send(JSON.stringify({ t: "register_browser", protocolVersion: 2, browserId: ids[0], name: "duplicate" }));
  assert.equal((await rejected)[0], 1008);
  assert.equal(value(await ca.callTool({ name: "get_page_info", arguments: {} })).browserId, ids[0]);

  hold = true;
  const received = new Promise(resolve => { held = resolve; });
  const pending = ca.callTool({ name: "get_page_info", arguments: {} });
  const request = await received;
  // B knows the request ID but is not its owner; it cannot complete A's call.
  b.send(JSON.stringify({ id: request.id, result: { browserId: "spoofed" } }));
  a.send(JSON.stringify({ id: request.id, result: { browserId: ids[0] } }));
  assert.equal(value(await pending).browserId, ids[0]);

  const waiting = new Promise(resolve => { held = resolve; });
  const interrupted = ca.callTool({ name: "execute_js", arguments: { code: "1" } });
  await waiting;
  const closed = once(a, "close");
  a.close();
  await closed;
  assert.equal((await interrupted).isError, true);
  const countB = seen[1].length;
  const offline = await ca.callTool({ name: "get_page_info", arguments: {} });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /offline/);
  assert.equal(seen[1].length, countB, "offline A never falls back to B");
  assert.equal((await unbound.callTool({ name: "get_page_info", arguments: {} })).isError, true,
    "one remaining registered browser still requires explicit selection");
  assert.equal(value(await cb.callTool({ name: "get_page_info", arguments: {} })).browserId, ids[1]);
  assert.equal(value(await unbound.callTool({ name: "list_browsers", arguments: {} })).find(x => x.browserId === ids[0]).connected, false);
  hold = false;
  await extension(ids[0], 0);
  assert.equal(value(await ca.callTool({ name: "get_page_info", arguments: {} })).browserId, ids[0], "same identity can reconnect");
  assert.equal((await unbound.callTool({ name: "get_page_info", arguments: {} })).isError, true, "no implicit target even after reconnect");
});
