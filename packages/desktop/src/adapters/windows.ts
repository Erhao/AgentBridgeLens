import { namedKeys } from "../keys.js";
import { fileURLToPath } from "node:url";
import { DesktopProcess } from "@agentbridgelens/runtime";

export class WindowsDesktop extends DesktopProcess {
  constructor() {
    if (!["x64", "arm64"].includes(process.arch)) {
      throw new Error("Windows desktop requires x64 or arm64 Node.js");
    }
    super("win32", {
      command:
        process.env.BRIDGELENS_WINDOWS_AGENT ||
        fileURLToPath(
          new URL(
            `../windows-agent/win-${process.arch}/AgentBridgeLens.Windows.exe`,
            import.meta.url,
          ),
        ),
      args: [],
      label:
        "Windows executor. Install a release containing windows-agent binaries or set BRIDGELENS_WINDOWS_AGENT",
    });
  }
  override send(
    tool: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    return super.send(
      tool,
      tool === "desktop_act" && params.action === "press_keys"
        ? { ...params, keys: namedKeys(params.keys) }
        : params,
      signal,
    );
  }
}
