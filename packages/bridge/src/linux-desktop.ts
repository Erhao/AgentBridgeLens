import { fileURLToPath } from "node:url";
import { DesktopProcess } from "./desktop.js";

export { registerDesktopTools } from "./desktop.js";

export class LinuxDesktop extends DesktopProcess {
  constructor() {
    super("linux", {
      command: process.env.BRIDGELENS_PYTHON || "/usr/bin/python3",
      args: ["-u", process.env.BRIDGELENS_LINUX_AGENT || fileURLToPath(new URL("../linux-agent/main.py", import.meta.url))],
      label: "Python",
    });
  }
}
