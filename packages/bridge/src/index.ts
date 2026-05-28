import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsRelay } from "./ws-relay.js";
import { createMcpServer } from "./mcp-server.js";

const WS_PORT = parseInt(process.env.BRIDGELENS_PORT || "19222", 10);

const relay = new WsRelay(WS_PORT);
const mcpServer = createMcpServer(relay);
const transport = new StdioServerTransport();

await mcpServer.connect(transport);
console.error(`[BridgeLens] MCP server started (WS port: ${WS_PORT})`);
