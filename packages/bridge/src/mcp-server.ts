import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsRelay } from "./ws-relay.js";

export function createMcpServer(relay: WsRelay): McpServer {
  const server = new McpServer({
    name: "AgentBridgeLens",
    version: "0.1.0",
  });

  server.tool(
    "get_page_info",
    "Get current page URL, title, and meta information",
    {},
    async () => {
      const result = await relay.send("get_page_info", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "capture_screenshot",
    "Capture a screenshot of the current page or a specific element",
    {
      selector: z.string().optional().describe("CSS selector to capture a specific element. Omit for full viewport."),
    },
    async ({ selector }) => {
      const result = (await relay.send("capture_screenshot", { selector })) as {
        dataUrl: string;
      };
      const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
    }
  );

  server.tool(
    "execute_js",
    "Execute a JavaScript expression in the page context and return the result",
    {
      code: z.string().describe("JavaScript code to execute in the page context"),
    },
    async ({ code }) => {
      const result = await relay.send("execute_js", { code });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_dom_snapshot",
    "Get a simplified DOM snapshot of the page or a specific subtree",
    {
      selector: z.string().optional().describe("CSS selector for subtree root. Omit for full page."),
      maxDepth: z.number().optional().describe("Maximum depth of DOM tree to capture. Default 6."),
    },
    async ({ selector, maxDepth }) => {
      const result = await relay.send("get_dom_snapshot", { selector, maxDepth });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "inspect_element",
    "Inspect a DOM element: get its attributes, computed styles, box model, and text content",
    {
      selector: z.string().describe("CSS selector of the element to inspect"),
    },
    async ({ selector }) => {
      const result = await relay.send("inspect_element", { selector });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "highlight_element",
    "Highlight an element on the page with a colored overlay border and label",
    {
      selector: z.string().describe("CSS selector of the element to highlight"),
      color: z.string().optional().describe("Highlight color (CSS color). Default: '#ff6b6b'"),
      label: z.string().optional().describe("Label text to show near the element"),
    },
    async ({ selector, color, label }) => {
      const result = await relay.send("highlight_element", { selector, color, label });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "clear_highlights",
    "Remove all highlight overlays from the page",
    {},
    async () => {
      const result = await relay.send("clear_highlights", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_console_logs",
    "Get captured console log entries from the page",
    {
      level: z
        .enum(["log", "warn", "error", "info", "debug"])
        .optional()
        .describe("Filter by log level"),
      limit: z.number().optional().describe("Maximum number of entries to return. Default 50."),
    },
    async ({ level, limit }) => {
      const result = await relay.send("get_console_logs", { level, limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_network_requests",
    "Get captured network request records from the page",
    {
      urlPattern: z.string().optional().describe("Filter by URL substring"),
      status: z.number().optional().describe("Filter by HTTP status code"),
    },
    async ({ urlPattern, status }) => {
      const result = await relay.send("get_network_requests", { urlPattern, status });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
