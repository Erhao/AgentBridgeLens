import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsRelay } from "./ws-relay.js";
import { createMcpServer } from "./mcp-server.js";

const WS_PORT = parseInt(process.env.BRIDGELENS_PORT || "19222", 10);
// Default to loopback. Set BRIDGELENS_HOST=0.0.0.0 to let a Chrome extension on
// another machine connect; pair it with BRIDGELENS_TOKEN so the channel is authenticated.
const WS_HOST = process.env.BRIDGELENS_HOST || "127.0.0.1";
const WS_TOKEN = process.env.BRIDGELENS_TOKEN || undefined;

const relay = new WsRelay({ port: WS_PORT, host: WS_HOST, token: WS_TOKEN });
const mcpServer = createMcpServer(relay);
const transport = new StdioServerTransport();

await mcpServer.connect(transport);
console.error(`[BridgeLens] MCP server started (WS ${WS_HOST}:${WS_PORT})`);
