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
const { StreamableHTTPClientTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
);
const dir = await mkdtemp(join(tmpdir(), "abl-macos-smoke-"));
let native;
let client;
let remoteBridge;
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
  const parse = (r) => JSON.parse(r.content[0].text);
  async function waitForMac(process, mcp) {
    let spawnError;
    process.on("error", (error) => (spawnError = error));
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (process.exitCode !== null || process.signalCode !== null) throw new Error("Native client exited");
      const caps = parse(await mcp.callTool({ name: "desktop_get_capabilities", arguments: {} }));
      if (caps.connected) return caps;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Mac app did not connect");
  }
  const caps = await waitForMac(native, client);
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
  assert.equal(diagnosis.updateChannelConfigured, process.env.ABL_REQUIRE_SIGNED_UPDATE === "1");
  const loadCommands = execFileSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8" });
  assert.match(loadCommands, /@rpath\/Sparkle\.framework/);
  await readFile(join(installed, "Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle"));
  assert.match(await readFile(join(installed, "Contents/Resources/Sparkle-LICENSE.txt"), "utf8"), /Andy Matuschak/);
  assert.equal(diagnosis.bundleIdentifier, "tech.xinyu.agentbridgemac");
  assert.equal(await realpath(diagnosis.appPath), await realpath(installed));
  assert.equal(typeof diagnosis.accessibility, "boolean");
  assert.equal(typeof diagnosis.screenCapture, "boolean");
  const menuIcon = await readFile(join(installed, "Contents/Resources/MenuLens.png"));
  assert.deepEqual([menuIcon.readUInt32BE(16), menuIcon.readUInt32BE(20)], [72, 72]);
  console.log(
    "PASS: packaged app launcher, bundled Node, real Swift client and unified MCP; desktop input was disabled.",
  );
  // Exercise the real App remote-mode client via the same loopback transport an
  // SSH tunnel presents. Deployment can also terminate WSS at a TLS proxy.
  native.kill();
  await once(native, "exit");
  native = undefined;
  await client.close();
  const macPort = await port();
  const httpPort = await port();
  const macToken = "mac-smoke-dedicated-token-0123456789";
  const httpToken = "http-smoke-dedicated-token-0123456789";
  const node = join(installed, "Contents/Helpers/node");
  const bridge = join(installed, "Contents/Resources/bridge/dist/index.js");
  remoteBridge = spawn(node, [bridge], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BRIDGELENS_"))),
      BRIDGELENS_TRANSPORT: "http", BRIDGELENS_PORT: await port(),
      BRIDGELENS_MAC_PORT: macPort, BRIDGELENS_HTTP_PORT: httpPort,
      BRIDGELENS_MAC_REMOTE_TOKEN: macToken, BRIDGELENS_HTTP_TOKEN: httpToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let log = "";
    remoteBridge.stderr.on("data", chunk => {
      log += chunk;
      if (log.includes("MCP Streamable HTTP listening")) resolve();
    });
    remoteBridge.once("error", reject);
    remoteBridge.once("exit", code => reject(new Error(`HTTP Bridge exited (${code}): ${log}`)));
  });
  client = new Client({ name: "remote-native-smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${httpToken}` } },
  }));
  native = spawn(binary, ["--transport-smoke-test"], {
    env: { ...process.env, ABL_MAC_SMOKE_REMOTE_URL: `ws://127.0.0.1:${macPort}/native`,
      ABL_MAC_SMOKE_REMOTE_TOKEN: macToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const remoteCaps = await waitForMac(native, client);
  assert.equal(remoteCaps.native.transportSmokeTest, true);
  assert.equal(remoteCaps.platform, "darwin");
  assert.equal(parse(await client.callTool({ name: "desktop_stop", arguments: {} })).stopped, true);
  console.log("PASS: installed Swift app in remote Bridge mode through authenticated HTTP MCP.");

} finally {
  native?.kill("SIGTERM");
  await client?.close();
  remoteBridge?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
