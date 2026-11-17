import {
  desktopSchemas,
  validateDesktopAction,
} from "@agentbridgelens/protocol";
import { mcpContent } from "@agentbridgelens/runtime";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { DesktopExecutor } from "@agentbridgelens/runtime";
export function registerDesktopTools(
  server: McpServer,
  desktop: DesktopExecutor,
) {
  const schemas = desktopSchemas(desktop.platform);
  const descriptions: Record<keyof typeof schemas, string> = {
    desktop_get_capabilities:
      "Inspect platform, dependencies, connection and permissions without requesting access. Check platform-specific limits before acting.",
    desktop_list_apps:
      "List applications exposed by this executor. This is not a complete process list.",
    desktop_list_windows:
      "List accessible windows, using executor-session-scoped windowId references. Coverage depends on the platform.",
    desktop_observe:
      "Read a bounded accessibility tree. Text is opt-in; protected values are omitted. Missing or truncated nodes do not prove absence. Screenshot capture needs an approved session.",
    desktop_start_session:
      "Request screen capture and optional input for the selected source. Windows and Mac require windowId. Mac requires existing OS permission and the local control switch; this call cannot grant permission. Linux uses the system Portal consent dialog.",
    desktop_capture_screenshot:
      "Capture the approved source as a PNG with screenshotId, dimensions and coordinate metadata. Image pixels belong only to that capture/session.",
    desktop_act:
      "Perform one explicit action. invoke/set_text/focus require snapshotId and target; pointer and key actions require a recent screenshotId. Check capabilities for platform limits. No automatic retry. accepted and verified are distinct.",
    desktop_wait_for:
      "Wait for an exact accessible name and/or role in a window, returning matches and a fresh snapshot. Bounded and cancellable.",
    desktop_stop:
      "Stop active and queued desktop work, invalidate references and close input/capture authorization. Browser tools are unaffected. Already dispatched OS events cannot be undone.",
  };
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    server.tool(
      name,
      descriptions[name],
      schemas[name] as Record<string, ZodTypeAny>,
      async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        if (name === "desktop_act") validateDesktopAction(args);
        return mcpContent(await desktop.send(name, args, extra.signal));
      },
    );
  }
}
