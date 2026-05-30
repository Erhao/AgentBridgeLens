import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsRelay } from "./ws-relay.js";
import { traceErrorToSource } from "./error-tracer.js";

export function createMcpServer(relay: WsRelay): McpServer {
  const server = new McpServer({ name: "AgentBridgeLens", version: "0.1.0" });

  // 目标标签页参数（页面类工具共用）：省略则用固定目标 / 当前激活页。
  const TAB = {
    tabId: z
      .number()
      .optional()
      .describe("目标标签页 id（来自 list_tabs）。省略则用已固定的目标标签页，否则用当前激活标签页"),
  };
  const asText = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  });

  // 页面类工具：自动附带可选 tabId，结果按文本返回。
  type Shape = Record<string, z.ZodTypeAny>;
  const page = (name: string, description: string, schema: Shape = {}) =>
    server.tool(name, description, { ...schema, ...TAB }, async (args) => asText(await relay.send(name, args)));
  // 非页面类工具（不需要 tabId）。
  const plain = (name: string, description: string, schema: Shape = {}) =>
    server.tool(name, description, schema, async (args) => asText(await relay.send(name, args)));

  // ---- 标签页定位 ----
  plain("list_tabs", "List all open tabs across all windows (tabId/title/url/active/isTarget/openedByTarget). Use this to pick a tab to operate on.");
  plain("set_target_tab", "Pin a tab as the target; all subsequent tools default to it regardless of which tab is focused.", {
    tabId: z.number().describe("Tab id to pin as target (from list_tabs)"),
  });
  plain("get_target_tab", "Get the currently pinned target tab (or follow-active mode if none).");
  plain("clear_target_tab", "Unpin the target tab; tools fall back to the active tab.");

  // ---- 看页面 / 抓现状 ----
  page("get_page_info", "Get current page URL, title, and meta information");

  server.tool(
    "capture_screenshot",
    "Capture a screenshot of a tab, or crop to a specific element. Background tabs are captured via CDP.",
    {
      selector: z.string().optional().describe("CSS selector to capture a specific element (scrolled into view and cropped). Omit for full viewport."),
      ...TAB,
    },
    async (args) => {
      const result = (await relay.send("capture_screenshot", args)) as { dataUrl: string };
      const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
      return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
    }
  );

  page("execute_js", "Execute a JavaScript expression in the page context and return the result (falls back to CDP on strict-CSP pages)", {
    code: z.string().describe("JavaScript code to execute in the page context"),
  });
  page("get_dom_snapshot", "Get a simplified DOM snapshot of the page or a specific subtree", {
    selector: z.string().optional().describe("CSS selector for subtree root. Omit for full page."),
    maxDepth: z.number().optional().describe("Maximum depth of DOM tree to capture. Default 6."),
  });
  page("inspect_element", "Inspect a DOM element: attributes, computed styles, box model, and text content", {
    selector: z.string().describe("CSS selector of the element to inspect"),
  });
  page("get_accessibility_tree", "Get a simplified accessibility tree (roles + accessible names) of the page or a subtree", {
    selector: z.string().optional().describe("CSS selector for subtree root. Omit for full page."),
    maxDepth: z.number().optional().describe("Maximum depth to traverse. Default 12."),
  });
  page("get_performance_metrics", "Get page performance metrics: navigation timing, FCP, LCP, CLS, JS heap memory");

  // ---- 定位 Bug：界面 → 代码 ----
  page("trace_element_to_source", "Trace a DOM element back to its source component file and line number (React/Vue dev builds)", {
    selector: z.string().describe("CSS selector of the element to trace"),
  });
  page("trace_style_to_source", "Trace which CSS rules apply to an element and which stylesheet they come from", {
    selector: z.string().describe("CSS selector of the element to trace"),
    property: z.string().optional().describe("Only return rules that set this CSS property"),
  });
  server.tool(
    "trace_error_to_source",
    "Resolve a JS error stack trace back to original source files/lines via source maps (runs in the bridge, fetches the bundle and .map)",
    { stack: z.string().describe("The error stack string (e.g. from Error.stack or get_errors output)") },
    async ({ stack }) => asText(await traceErrorToSource(stack))
  );

  // ---- 网络 / 控制台 ----
  page("get_console_logs", "Get captured console log entries from the page", {
    level: z.enum(["log", "warn", "error", "info", "debug"]).optional().describe("Filter by log level"),
    limit: z.number().optional().describe("Maximum number of entries to return. Default 50."),
  });
  page("get_errors", "Get only error-level console entries (uncaught errors and rejections included)");
  page("get_network_requests", "Get network requests captured (lightweight; only those after content-script injection)", {
    urlPattern: z.string().optional().describe("Filter by URL substring"),
    status: z.number().optional().describe("Filter by HTTP status code"),
  });
  page("start_cdp_network", "Attach the Chrome debugger to a tab and start capturing full network traffic via CDP. Shows a debugging banner; works per-tab (multiple tabs supported).");
  page("stop_cdp_network", "Detach the Chrome debugger and stop CDP network capture for a tab");
  page("get_cdp_network", "Get network requests captured via CDP for a tab (requires start_cdp_network first)", {
    urlPattern: z.string().optional().describe("Filter by URL substring"),
    status: z.number().optional().describe("Filter by HTTP status code"),
  });

  // ---- 视觉叠加 ----
  page("mark_elements", "Mark/annotate a set of elements with colored boxes (e.g. to flag changed regions)", {
    selectors: z.array(z.string()).describe("CSS selectors of elements to mark"),
    color: z.string().optional().describe("Box color (CSS color). Default '#ff3b30'"),
    label: z.string().optional().describe("Optional label text shown on each box"),
  });
  page("visualize_layout", "Outline elements whose content is clipped by overflow (layout debugging)");
  page("show_responsive_frame", "Overlay a target-viewport-width frame and list elements wider than it (responsive debugging)", {
    width: z.number().optional().describe("Target viewport width in px. Default 375."),
  });
  page("clear_overlays", "Remove all visual overlays (marks / layout / responsive frame)");

  // ---- 录制 / 回放 ----
  page("start_recording", "Start recording user interactions (clicks, inputs, scrolls) on a tab");
  page("stop_recording", "Stop recording and return the captured action sequence");
  page("replay_actions", "Replay a previously recorded action sequence on a tab", {
    actions: z.array(z.record(z.string(), z.unknown())).describe("Action sequence, as returned by stop_recording"),
  });

  // ---- HUD ----
  page("show_hud", "Show a small on-page HUD panel in the bottom-right corner");
  page("hide_hud", "Hide the on-page HUD panel");
  page("update_hud", "Update the HUD status text", {
    text: z.string().describe("Status text to display in the HUD"),
  });

  // ---- 交互式确认（不针对具体页面）----
  plain(
    "request_user_confirmation",
    "Ask the user a question in the side panel and wait for their choice (the AgentBridgeLens side panel must be open).",
    {
      message: z.string().describe("The question/prompt shown to the user"),
      options: z.array(z.string()).optional().describe("Choice buttons. Default ['确认', '取消']"),
    }
  );

  return server;
}
