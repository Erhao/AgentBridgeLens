import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WsRelay } from "@agentbridgelens/browser-adapter";
import { z } from "zod";

/** Decorate browser registrations only; desktop tools keep their own routing. */
export function routedBrowserServer(server: McpServer, relay: WsRelay, boundBrowserId?: string): McpServer {
  const browserId = z.string().min(1).max(200).optional().describe(
    "Browser installation ID from list_browsers. Required unless the MCP endpoint is bound to a browser. Never substitute another browser when offline.",
  );
  return new Proxy(server, {
    get(target, property) {
      if (property !== "tool") return Reflect.get(target, property, target);
      return (name: string, description: string, schema: Record<string, z.ZodTypeAny>, callback: (...args: any[]) => any) =>
        target.tool(name, description, { ...schema, browserId }, async (args, extra) => {
          const { browserId: requested, ...params } = args;
          if (boundBrowserId && requested && requested !== boundBrowserId)
            throw new Error("browserId conflicts with this MCP endpoint's browser binding.");
          const selected = boundBrowserId ?? requested;
          return relay.withBrowser(selected, () => callback(params, extra));
        });
    },
  });
}
