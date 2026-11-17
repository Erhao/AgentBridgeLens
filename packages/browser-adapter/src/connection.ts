import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BridgeRequest } from "@agentbridgelens/protocol/browser";
import { executorResponse } from "@agentbridgelens/protocol";
import { PendingRequests } from "@agentbridgelens/runtime";
export interface WsRelayOptions {
  port: number;
  host?: string;
  token?: string;
}
export class WsRelay {
  private wss: WebSocketServer;
  private http: Server;
  private client: WebSocket | null = null;
  private pending = new PendingRequests();
  constructor(private options: WsRelayOptions) {
    const host = options.host || "127.0.0.1";
    this.http = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (req.url !== "/health" || req.method !== "GET")
        res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      else if (
        options.token &&
        req.headers.authorization !== `Bearer ${options.token}`
      )
        res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      else
        res
          .writeHead(200)
          .end(JSON.stringify({ service: "AgentBridgeLens", status: "ok" }));
    });
    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: 24 * 1024 * 1024,
      verifyClient: (info, done) => {
        if (this.authorize(info.req)) done(true);
        else done(false, 401, "Unauthorized");
      },
    });
    this.http.listen(options.port, host);
    this.http.on("error", (error) => {
      console.error("[BridgeLens] Browser relay failed:", error.message);
      this.close();
    });
    this.wss.on("connection", (ws, req: IncomingMessage) => {
      const old = this.client;
      this.client = ws;
      if (old) {
        this.pending.rejectOwner(
          old,
          new Error("Extension connection replaced"),
        );
        old.terminate();
      }
      console.error(
        `[BridgeLens] Extension connected from ${req.socket.remoteAddress}`,
      );
      // MV3 needs application messages, rather than protocol ping, to remain awake.
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "ping" }));
      }, 20000);
      ws.on("error", () => ws.terminate());
      ws.on("message", (raw) => {
        try {
          const msg = executorResponse.safeParse(JSON.parse(raw.toString()));
          if (!msg.success) {
            ws.close(1008, "Invalid browser response");
            return;
          }
          this.pending.settle(
            ws,
            msg.data.id,
            msg.data.error ? new Error(msg.data.error.message) : undefined,
            msg.data.result,
          );
        } catch {
          ws.close(1008, "Invalid browser JSON");
        }
      });
      ws.on("close", () => {
        clearInterval(heartbeat);
        if (this.client === ws) this.client = null;
        this.pending.rejectOwner(ws, new Error("Extension disconnected"));
      });
    });
    if (host !== "127.0.0.1" && !options.token)
      console.error(
        `[BridgeLens] WARNING: browser control on ${host}:${options.port} has no authentication.`,
      );
    console.error(
      `[BridgeLens] WebSocket server listening on ${host}:${options.port} (${options.token ? "token required" : "no token"})`,
    );
  }
  private authorize(req: IncomingMessage) {
    if (!this.options.token) return true;
    try {
      return (
        new URL(req.url ?? "/", "ws://localhost").searchParams.get("token") ===
        this.options.token
      );
    } catch {
      return false;
    }
  }
  get connected() {
    return this.client?.readyState === WebSocket.OPEN;
  }
  async send(
    tool: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ws = this.client;
    if (!ws || !this.connected)
      throw new Error(
        "Chrome extension not connected. Please open Chrome with the AgentBridgeLens extension installed.",
      );
    const request = this.pending.create(ws, {
      timeoutMs: 120000,
      signal,
      timeoutMessage: `Tool '${tool}' timed out after 120s; its outcome may be unknown.`,
    });
    if (this.pending.has(ws, request.id)) {
      const wire: BridgeRequest = { id: request.id, tool, params };
      ws.send(JSON.stringify(wire), (error) => {
        if (error) this.pending.settle(ws, request.id, error);
      });
    }
    return request.promise;
  }
  close() {
    this.pending.rejectAll(new Error("Browser relay stopped"));
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.http.close();
  }
}
