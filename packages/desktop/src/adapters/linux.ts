import { linuxKeys } from "../keys.js";
import { fileURLToPath } from "node:url";
import { DesktopProcess } from "@agentbridgelens/runtime";

export class LinuxDesktop extends DesktopProcess {
  constructor() {
    super("linux", {
      command: process.env.BRIDGELENS_PYTHON || "/usr/bin/python3",
      args: [
        "-u",
        process.env.BRIDGELENS_LINUX_AGENT ||
          fileURLToPath(new URL("../linux-agent/main.py", import.meta.url)),
      ],
      label: "Python",
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
        ? { ...params, keys: linuxKeys(params.keys) }
        : params,
      signal,
    );
  }
}
