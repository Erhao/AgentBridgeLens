#!/usr/bin/env node
import { version } from "./version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsRelay } from "./ws-relay.js";
import { createMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http-server.js";
import { LinuxDesktop, WindowsDesktop, MacDesktop } from "@agentbridgelens/desktop";
import { readToken } from "@agentbridgelens/runtime";

if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}

const WS_PORT = parseInt(process.env.BRIDGELENS_PORT || "19222", 10);
// Default to loopback. Set BRIDGELENS_HOST=0.0.0.0 to let a Chrome extension on
// another machine connect; pair it with BRIDGELENS_TOKEN so the channel is authenticated.
const WS_HOST = process.env.BRIDGELENS_HOST || "127.0.0.1";
const WS_TOKEN = process.env.BRIDGELENS_TOKEN || undefined;

const mode = process.env.BRIDGELENS_TRANSPORT || "stdio";
if (mode !== "stdio" && mode !== "http") {
  throw new Error("BRIDGELENS_TRANSPORT must be 'stdio' or 'http'");
}
const httpHost = process.env.BRIDGELENS_HTTP_HOST || "127.0.0.1";
const httpPort = Number(process.env.BRIDGELENS_HTTP_PORT || "19223");
const httpToken = process.env.BRIDGELENS_HTTP_TOKEN || WS_TOKEN;
if (mode === "http") {
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error("BRIDGELENS_HTTP_PORT must be an integer between 1 and 65535");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(httpHost) && !httpToken) {
    throw new Error("Set BRIDGELENS_HTTP_TOKEN (or BRIDGELENS_TOKEN) when exposing HTTP beyond loopback");
  }
}

if (process.argv.includes("--init-mac")) {
  readToken(process.env.BRIDGELENS_MAC_TOKEN_FILE ?? process.env.AGENTBRIDGEMAC_TOKEN_FILE);
  console.log("Mac pairing ready. Open AgentBridgeMac.app and enable BRIDGELENS_DESKTOP=1 in this MCP service.");
  process.exit(0);
}

if (process.env.BRIDGELENS_DESKTOP === "1" && !["linux", "win32", "darwin"].includes(process.platform)) {
  throw new Error("BRIDGELENS_DESKTOP=1 supports macOS, Linux and Windows");
}
const desktop = process.env.BRIDGELENS_DESKTOP === "1"
  ? (process.platform === "darwin" ? await MacDesktop.create() : process.platform === "win32" ? new WindowsDesktop() : new LinuxDesktop())
  : undefined;
const relay = new WsRelay({ port: WS_PORT, host: WS_HOST, token: WS_TOKEN });
process.once("exit", () => desktop?.close());
try {
  if (mode === "http") {
    const http = await startHttpServer(relay, {
      host: httpHost,
      port: httpPort,
      token: httpToken,
      desktop,
      allowedOrigins: (process.env.BRIDGELENS_HTTP_ALLOWED_ORIGINS || "")
        .split(",").map((origin) => origin.trim()).filter(Boolean),
    });
    console.error(`[BridgeLens] MCP Streamable HTTP listening on ${httpHost}:${httpPort}/mcp`);
    const shutdown = async () => {
      await desktop?.stopAndClose();
      await http.close();
      relay.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } else {
    const mcpServer = createMcpServer(relay, desktop);
    const shutdown = async () => { await desktop?.stopAndClose(); relay.close(); process.exit(0); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
    await mcpServer.connect(new StdioServerTransport());
    console.error(`[BridgeLens] MCP stdio started (WS ${WS_HOST}:${WS_PORT})`);
  }
} catch (error) {
  desktop?.close();
  relay.close();
  throw error;
}
