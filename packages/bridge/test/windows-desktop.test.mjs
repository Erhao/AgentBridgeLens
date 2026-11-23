import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Compile source-only adapters for protocol tests; do not produce a release package.
const temporary = await mkdtemp(fileURLToPath(new URL("../node_modules/.windows-desktop-test-", import.meta.url)));
after(() => rm(temporary, { recursive: true, force: true }));
await build({ entry: { desktop: fileURLToPath(new URL("../src/desktop.ts", import.meta.url)),
  windows: fileURLToPath(new URL("../src/windows-desktop.ts", import.meta.url)) },
  outDir: temporary, outExtension: () => ({ js: ".mjs" }), format: ["esm"], dts: false, silent: true, noExternal: [/^@agentbridgelens\//],
  // Keep production dependencies external even when installed-package checks
  // invoke this source-only helper from the workspace root.
  external: ["ws", "zod"],
});
const { DesktopProcess, registerDesktopTools } = await import(pathToFileURL(join(temporary, "desktop.mjs")));
const { WindowsDesktop } = await import(pathToFileURL(join(temporary, "windows.mjs")));

test("Windows MCP requires a window scope and named keys; Linux numeric keys remain compatible", async (t) => {
  for (const platform of ["linux", "win32"]) {
    const sent = [];
    const desktop = { platform, send: async (tool, args) => { sent.push({ tool, args }); return { accepted: true }; } };
    const server = new McpServer({ name: "desktop-schema", version: "1" });
    registerDesktopTools(server, desktop);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "desktop-schema-test", version: "1" });
    t.after(() => client.close());
    t.after(() => server.close());
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 9);
    const start = await client.callTool({ name: "desktop_start_session", arguments: { sessionId: "s" } });
    assert.equal(Boolean(start.isError), platform === "win32");
    for (const keys of [[29, 31], ["CTRL", "S"]]) {
      const previous = sent.length;
      const result = await client.callTool({ name: "desktop_act", arguments: { sessionId: "s", action: "press_keys", keys, screenshotId: "frame" } });
      const valid = platform !== "win32" || typeof keys[0] === "string";
      assert.equal(Boolean(result.isError), !valid);
      assert.equal(sent.length, previous + Number(valid));
    }
    if (platform === "win32") {
      const result = await client.callTool({ name: "desktop_start_session", arguments: { sessionId: "s", windowId: "w", input: true } });
      assert.ok(!result.isError);
      assert.equal(sent.at(-1).args.windowId, "w");
    }
  }
});

test("missing Windows executable has a useful error and can be diagnosed again", async (t) => {
  const saved = process.env.BRIDGELENS_WINDOWS_AGENT;
  process.env.BRIDGELENS_WINDOWS_AGENT = join(temporary, "not-installed.exe");
  const desktop = new WindowsDesktop();
  if (saved === undefined) delete process.env.BRIDGELENS_WINDOWS_AGENT;
  else process.env.BRIDGELENS_WINDOWS_AGENT = saved;
  t.after(() => desktop.close());
  for (let i = 0; i < 2; i++)
    await assert.rejects(desktop.send("desktop_get_capabilities"), /Install a release containing windows-agent binaries or set BRIDGELENS_WINDOWS_AGENT/);
});

test("Windows process adapter preserves argv paths and never retries a crashed action", async (t) => {
  const fixture = fileURLToPath(new URL("fixtures/windows worker.mjs", import.meta.url));
  const desktop = new DesktopProcess("win32", { command: process.execPath, args: [fixture], label: "Windows fixture" });
  t.after(() => desktop.close());
  const before = await desktop.send("desktop_get_capabilities");
  await assert.rejects(desktop.send("desktop_act", { action: "invoke" }), /exited/);
  const after = await desktop.send("desktop_get_capabilities");
  assert.notEqual(before.sessionId, after.sessionId);
  await desktop.stopAndClose();
  await assert.rejects(desktop.send("desktop_get_capabilities"), /closed/);
});

test("Windows Bridge routes MCP to the packaged executor and rejects stale sessions", { timeout: 15000, skip: process.platform !== "win32" }, async (t) => {
  const { createServer } = await import("node:net");
  const { once } = await import("node:events");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = String(listener.address().port);
  await new Promise((resolve) => listener.close(resolve));
  const entry = process.env.ABL_BRIDGE_ENTRY || fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const executable = process.env.BRIDGELENS_WINDOWS_AGENT || fileURLToPath(new URL(`../windows-agent/win-${process.arch}/AgentBridgeLens.Windows.exe`, import.meta.url));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BRIDGELENS_")));
  const client = new Client({ name: "windows-native-smoke", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe",
    env: { ...environment, BRIDGELENS_DESKTOP: "1", BRIDGELENS_PORT: port, BRIDGELENS_WINDOWS_AGENT: executable } }));
  assert.equal((await client.listTools()).tools.filter(({ name }) => name.startsWith("desktop_")).length, 9);
  const parse = (response) => JSON.parse(response.content[0].text);
  const caps = parse(await client.callTool({ name: "desktop_get_capabilities", arguments: {} }));
  assert.equal(caps.platform, "win32");
  assert.equal(typeof caps.graphicalSession, "boolean");
  const stale = await client.callTool({ name: "desktop_list_windows", arguments: { sessionId: "old" } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE_SESSION/);
  assert.equal(parse(await client.callTool({ name: "desktop_stop", arguments: {} })).sharingClosed, true);
});
