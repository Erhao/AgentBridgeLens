import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  executorResponse,
  ExecutorError,
  type DesktopPlatform,
} from "@agentbridgelens/protocol";
import { PendingRequests } from "./pending.js";
import type { DesktopExecutor } from "./executor.js";
export interface ExecutorCommand {
  command: string;
  args: string[];
  label: string;
}
export class DesktopProcess implements DesktopExecutor {
  constructor(
    readonly platform: DesktopPlatform,
    private readonly launch: ExecutorCommand,
  ) {}
  private child?: ChildProcessWithoutNullStreams;
  private pending = new PendingRequests();
  private closed = false;
  async send(
    tool: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed) throw new Error("Desktop executor is closed");
    if (signal?.aborted)
      throw new ExecutorError("CANCELLED", "Request already cancelled");
    if (this.pending.size >= (tool === "desktop_stop" ? 33 : 32))
      throw new Error("Desktop request queue is full");
    const child = this.child ?? this.start();
    const request = this.pending.create(child, {
      timeoutMs: tool === "desktop_start_session" ? 125_000 : 45_000,
      signal,
      onCancel: (id) => {
        if (!child.killed)
          child.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n");
      },
      onTimeout: () =>
        this.fail(
          child,
          new Error(
            "Desktop executor timed out and was stopped. An action may already have occurred; observe again before retrying.",
          ),
        ),
    });
    if (this.pending.has(child, request.id))
      child.stdin.write(
        JSON.stringify({ id: request.id, tool, params }) + "\n",
        (error) => {
          if (error) this.fail(child, error);
        },
      );
    return request.promise;
  }
  private start() {
    const child = spawn(this.launch.command, this.launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
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
          const response = executorResponse.parse(JSON.parse(line));
          this.pending.settle(
            child,
            response.id,
            response.error
              ? new ExecutorError(
                  response.error.code ?? "DESKTOP_ERROR",
                  response.error.message,
                )
              : undefined,
            response.result,
          );
        } catch {
          this.fail(
            child,
            new Error("Desktop executor emitted invalid JSON protocol"),
          );
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) =>
      this.fail(
        child,
        new Error(
          `Cannot start desktop ${this.launch.label}: ${error.message}`,
        ),
      ),
    );
    child.stdin.on("error", (error) => this.fail(child, error));
    child.on("exit", (code, signal) =>
      this.fail(
        child,
        new Error(
          `Desktop executor exited (${signal || code}); observe again before retrying actions`,
        ),
      ),
    );
    return child;
  }
  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = undefined;
    child.kill("SIGKILL");
    this.pending.rejectOwner(child, error);
  }
  close() {
    this.closed = true;
    if (this.child)
      this.fail(this.child, new Error("Desktop executor stopped"));
  }
  async stopAndClose() {
    if (!this.child) {
      this.close();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.send("desktop_stop"),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch {
    } finally {
      clearTimeout(timer);
      this.close();
    }
  }
}
