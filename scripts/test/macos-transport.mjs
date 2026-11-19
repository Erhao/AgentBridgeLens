import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../../packages/bridge/package.json", import.meta.url),
);
const { Client } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const dir = await mkdtemp(join(tmpdir(), "abl-macos-smoke-"));
let native;
let client;
async function port() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return String(value);
}
try {
  const source = resolve(
      process.argv[2] ??
        "artifacts/AgentBridgeLens.app/Contents/MacOS/AgentBridgeMac",
    );
  const installed = join(dir, "Mac Applications", "AgentBridgeLens.app");
  const sourceApp = resolve(dirname(source), "../..");
  execFileSync("/usr/bin/ditto", [sourceApp, installed]);
  const binary = join(installed, "Contents/MacOS/AgentBridgeMac");
  const env = {
    ...process.env,
    BRIDGELENS_DESKTOP: "1",
    BRIDGELENS_PORT: await port(),
    BRIDGELENS_MAC_PORT: await port(),
    BRIDGELENS_MAC_TOKEN_FILE: join(dir, "token"),
  };
  client = new Client({ name: "unified-native-smoke", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["--mcp"],
      env,
      stderr: "pipe",
    }),
  );
  native = spawn(binary, ["--transport-smoke-test"], {
    env: {
      ...process.env,
      AGENTBRIDGEMAC_PORT: env.BRIDGELENS_MAC_PORT,
      AGENTBRIDGEMAC_TOKEN_FILE: env.BRIDGELENS_MAC_TOKEN_FILE,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let spawnError;
  native.on("error", (error) => (spawnError = error));
  const parse = (r) => JSON.parse(r.content[0].text);
  let caps;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (native.exitCode !== null) throw new Error("Native client exited");
    caps = parse(
      await client.callTool({
        name: "desktop_get_capabilities",
        arguments: {},
      }),
    );
    if (caps.connected) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(caps.platform, "darwin");
  assert.equal(caps.native.transportSmokeTest, true);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.filter((t) => t.name.startsWith("desktop_")).length, 9);
  assert.equal(tools.filter((t) => t.name.startsWith("mac_")).length, 7);
  assert.ok(tools.some((t) => t.name === "get_dom_snapshot"));
  assert.equal(
    parse(await client.callTool({ name: "desktop_stop", arguments: {} }))
      .stopped,
    true,
  );
  const version = JSON.parse(
    await readFile("platforms/macos/version.json", "utf8"),
  ).version;
  const diagnosis = JSON.parse(execFileSync(binary, ["--diagnose"], { encoding: "utf8" }));
  assert.equal(diagnosis.version, version);
  assert.equal(diagnosis.bundledBridge, true);
  assert.equal(diagnosis.bundleIdentifier, "tech.xinyu.agentbridgemac");
  assert.equal(await realpath(diagnosis.appPath), await realpath(installed));
  assert.equal(typeof diagnosis.accessibility, "boolean");
  assert.equal(typeof diagnosis.screenCapture, "boolean");
  console.log(
    "PASS: packaged app launcher, bundled Node, real Swift client and unified MCP; desktop input was disabled.",
  );
} finally {
  native?.kill("SIGTERM");
  await client?.close();
  await rm(dir, { recursive: true, force: true });
}
