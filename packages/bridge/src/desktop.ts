import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** One local executor per Bridge, shared by stateless HTTP MCP requests. */
export interface DesktopExecutor {
  readonly platform: "linux" | "win32";
  send(tool: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
  stopAndClose(): Promise<void>;
}

export interface ExecutorCommand {
  command: string;
  args: string[];
  label: string;
}

export class DesktopProcess implements DesktopExecutor {
  constructor(readonly platform: "linux" | "win32", private readonly launch: ExecutorCommand) {}
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  async send(tool: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) throw new Error("Desktop executor is closed");
    // Reserve one slot for stop, including when ordinary requests fill the queue.
    if (this.pending.size >= (tool === "desktop_stop" ? 33 : 32)) throw new Error("Desktop request queue is full");
    const child = this.child ?? this.start();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      // Includes queue time. Never retry an action after a timeout: its outcome
      // may be unknown. Killing the worker also releases its portal connection.
      const timer = setTimeout(() => this.fail(child, new Error(
        "Desktop executor timed out and was stopped. An action may already have occurred; observe again before retrying."
      )), tool === "desktop_start_session" ? 125_000 : 45_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, tool, params }) + "\n", (error) => {
        if (error) this.fail(child, error);
      });
    });
  }

  private start() {
    const child = spawn(this.launch.command, this.launch.args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 24 * 1024 * 1024) {
        this.fail(child, new Error("Desktop response exceeded 24 MiB"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (typeof response.id !== "string" || (!response.error && !("result" in response))) {
            throw new Error("Invalid desktop response");
          }
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          if (response.error) pending.reject(new Error(`[${response.error.code || "DESKTOP_ERROR"}] ${response.error.message}`));
          else pending.resolve(response.result);
        } catch {
          this.fail(child, new Error("Desktop executor emitted invalid JSON protocol"));
          return;
        }
      }
    });
    // Native diagnostics never enter the MCP stdout channel.
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => this.fail(child, new Error(`Cannot start desktop ${this.launch.label}: ${error.message}`)));
    child.stdin.on("error", (error) => this.fail(child, error));
    child.on("exit", (code, signal) => this.fail(child, new Error(`Desktop executor exited (${signal || code}); observe again before retrying actions`)));
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    // Events from an old process must not reject requests sent to a new one.
    if (this.child !== child) return;
    this.child = undefined;
    child.kill("SIGKILL");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    if (this.child) this.fail(this.child, new Error("Desktop executor stopped"));
  }

  async stopAndClose() {
    if (!this.child) { this.close(); return; }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.send("desktop_stop"),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
      ]);
    } catch {
      // A disconnected worker has already released its portal connection.
    } finally {
      clearTimeout(timer);
      this.close();
    }
  }
}

/** Convert screenshots into MCP image blocks without duplicating base64 in text. */
function content(result: any) {
  const screenshot = result.screenshot;
  if (!screenshot?.data) return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  const { data, ...metadata } = screenshot;
  return { content: [
    { type: "text" as const, text: JSON.stringify({ ...result, screenshot: metadata }, null, 2) },
    { type: "image" as const, data, mimeType: "image/png" },
  ] };
}

export function registerDesktopTools(server: McpServer, desktop: DesktopExecutor) {
  const windows = desktop.platform === "win32";
  const session = { sessionId: z.string().min(1).describe("Executor sessionId from desktop_get_capabilities; changes when the executor restarts") };
  const tool = (name: string, description: string, schema: Record<string, z.ZodTypeAny> = {}) =>
    server.tool(name, description, schema, async (args) => content(await desktop.send(name, args)));

  tool("desktop_get_capabilities", "Inspect the local desktop executor, platform, dependencies and current permissions. Does not request screen/input access.");
  tool("desktop_list_apps", windows ? "List applications with visible Win32 top-level windows (not all running processes)." : "List applications visible through AT-SPI (not all running processes).", session);
  tool("desktop_list_windows", windows ? "List visible Win32 top-level windows. Window IDs are session-scoped." : "List AT-SPI top-level windows. Window IDs are session-scoped; this is not a complete compositor window list.", {
    ...session, appId: z.string().optional(),
  });
  tool("desktop_observe", "Read a bounded accessibility tree for a window. Returns short-lived node references. Does not request permissions. Password contents are omitted.", {
    ...session, windowId: z.string(),
    maxDepth: z.number().int().min(0).max(16).default(6),
    maxNodes: z.number().int().min(1).max(1000).default(300),
    includeText: z.boolean().default(false),
    includeScreenshot: z.boolean().default(false),
    streamId: z.number().int().positive().optional(),
  });
  tool("desktop_start_session", windows ? "Request local approval to capture one window and optionally control it. Requires windowId; all mutations require input:true. Shows a Windows consent dialog; no persistent permission." : "Request screen sharing and optional keyboard/pointer access through the local desktop Portal. Shows the system consent dialog. First release uses Notify input, no persistent permissions.", {
    ...session, ...(windows ? { windowId: z.string().min(1) } : {}), input: z.boolean().default(false),
    multiple: z.boolean().default(false),
  });
  tool("desktop_capture_screenshot", "Capture the approved source as a PNG image with coordinate metadata. Requires desktop_start_session. Select streamId when sharing multiple sources.", {
    ...session, streamId: z.number().int().positive().optional(),
  });
  tool("desktop_act", "Perform one desktop action, then inspect accepted/verified separately. Accessibility actions require snapshotId and target. Pointer actions require a recent screenshotId and image-pixel coordinates; keys require that screenshotId too. Windows requires local input approval for all actions. No automatic retry.", {
    ...session,
    action: z.enum(["invoke", "set_text", "focus", "click", "move", "scroll", "press_keys"]),
    snapshotId: z.string().optional(), target: z.string().optional(),
    actionName: z.string().max(100).optional(), text: z.string().max(100_000).optional(),
    screenshotId: z.string().optional(), x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
    button: z.enum(["left", "middle", "right"]).default("left"),
    dx: z.number().min(-1000).max(1000).optional(), dy: z.number().min(-1000).max(1000).optional(),
    keys: (windows
      ? z.array(z.string().min(1).max(20)).min(1).max(8).describe("Windows named keys, e.g. [CTRL,S], [ENTER], [ALT,F4]. Not text input. Numeric Linux evdev codes are rejected.")
      : z.array(z.number().int().min(1).max(767)).min(1).max(8).describe("Linux evdev keycodes, e.g. Ctrl+S = [29,31]. Not text input.")
    ).optional(),
  });
  tool("desktop_wait_for", "Wait for a node matching exact accessible name and/or role in a window. Polls a bounded tree; cancellable with desktop_stop. Returns a fresh snapshot and matching node references.", {
    ...session, windowId: z.string(), name: z.string().max(1000).optional(), role: z.string().max(100).optional(),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
  });
  tool("desktop_stop", "Cancel active/queued desktop work, discard references and close screen/input permissions. Browser tools are unaffected.");
}
