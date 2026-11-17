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

export function createMcpServer(
  relay: WsRelay,
  desktop?: DesktopExecutor,
): McpServer {
  const server = new McpServer({ name: "AgentBridgeLens", version });
  registerBrowserTools(server, relay);
  if (desktop) registerDesktopTools(server, desktop);
  if (desktop instanceof MacDesktop)
    registerMacCompatibilityTools(server, desktop);
  return server;
}
