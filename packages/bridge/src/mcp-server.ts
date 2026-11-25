import { version } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WsRelay } from "@agentbridgelens/browser-adapter";
import {
  registerDesktopTools,
  registerMacCompatibilityTools,
  MacDesktop,
  type DesktopExecutor,
} from "@agentbridgelens/desktop";
import { registerBrowserTools } from "./mcp/browser-tools.js";
import { routedBrowserServer } from "./mcp/browser-routing.js";

export function createMcpServer(
  relay: WsRelay,
  desktop?: DesktopExecutor,
  boundBrowserId = process.env.BRIDGELENS_BROWSER_ID,
): McpServer {
  const server = new McpServer({ name: "AgentBridgeLens", version });
  server.tool("list_browsers", "List registered browser IDs, names and online status. Select an explicit browserId before browser operations; tab IDs are only unique inside that browser.", {}, async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(relay.listBrowsers(), null, 2) }],
  }));
  registerBrowserTools(routedBrowserServer(server, relay, boundBrowserId), relay);
  if (desktop) registerDesktopTools(server, desktop);
  if (desktop instanceof MacDesktop)
    registerMacCompatibilityTools(server, desktop);
  return server;
}
