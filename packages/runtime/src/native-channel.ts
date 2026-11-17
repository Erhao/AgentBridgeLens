import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  nativeHello,
  executorResponse,
  ExecutorError,
} from "@agentbridgelens/protocol";
import { PendingRequests } from "./pending.js";
export { ExecutorError as NativeError } from "@agentbridgelens/protocol";
export type NativeInfo = {
  deviceId: string;
  version: string;
  capabilities: string[];
};
/** Authenticated native wire v1. Independent of the browser relay. */
export class MacRelay {
  private http: Server;
  private wss: WebSocketServer;
  private client?: WebSocket;
  private info?: NativeInfo;
  private sessionId?: string;
  private pending = new PendingRequests();
  private heartbeat: NodeJS.Timeout;
  private alive = new WeakSet<WebSocket>();
  constructor(
    private options: {
      token: string;
      port: number;
      timeoutMs?: number;
      handshakeMs?: number;
    },
  ) {
    this.http = createServer((_req, res) => {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 12 * 1024 * 1024,
    });
    this.http.on("upgrade", (req, socket, head) => {
      const digest = (s: string) => createHash("sha256").update(s).digest();
      if (
        req.url !== "/native" ||
        req.headers.origin ||
        !timingSafeEqual(
          digest(req.headers.authorization ?? ""),
          digest(`Bearer ${options.token}`),
        )
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (this.client) {
        socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.wss.emit("connection", ws),
      );
    });
    this.wss.on("connection", (ws) => this.attach(ws));
    this.heartbeat = setInterval(() => {
      const ws = this.client;
      if (!ws) return;
      if (!this.alive.has(ws)) {
        ws.terminate();
        return;
      }
      this.alive.delete(ws);
      ws.ping();
    }, 10000);
    this.heartbeat.unref();
  }
  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, "127.0.0.1", () => {
        this.http.off("error", reject);
        const a = this.http.address();
        resolve(typeof a === "object" && a ? a.port : this.options.port);
      });
    });
  }
  get status() {
    return {
      connected: !!this.info && this.client?.readyState === WebSocket.OPEN,
      device: this.info ?? null,
      sessionId: this.sessionId ?? null,
    };
  }
  private attach(ws: WebSocket) {
    this.client = ws;
    this.alive.add(ws);
    const timer = setTimeout(
      () => ws.close(1008, "Hello required"),
      this.options.handshakeMs ?? 5000,
    );
    ws.on("pong", () => this.alive.add(ws));
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(timer);
      if (this.client === ws) {
        this.client = undefined;
        this.info = undefined;
        this.sessionId = undefined;
      }
      this.pending.rejectOwner(
        ws,
        new ExecutorError(
          "DISCONNECTED",
          "Mac app disconnected; action outcome may be unknown. Observe before retrying.",
        ),
      );
    });
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object" || Array.isArray(msg))
          throw new Error();
      } catch {
        ws.close(1008, "Invalid JSON message");
        return;
      }
      if (!this.info) {
        const hello = nativeHello.safeParse(msg);
        if (!hello.success) {
          ws.close(1008, "Unsupported hello");
          return;
        }
        clearTimeout(timer);
        this.info = hello.data;
        this.sessionId = randomUUID();
        ws.send(JSON.stringify({ type: "hello_ack", protocolVersion: 1 }));
        return;
      }
      if (msg.type !== "response") return;
      const response = executorResponse.safeParse(msg);
      if (!response.success) {
        ws.close(1008, "Invalid native response");
        return;
      }
      const value = response.data;
      this.pending.settle(
        ws,
        value.id,
        value.error
          ? new ExecutorError(
              value.error.code ?? "NATIVE_ERROR",
              value.error.message,
            )
          : undefined,
        value.result,
      );
    });
  }
  send(
    tool: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    const ws = this.client;
    if (!this.status.connected || !ws)
      return Promise.reject(
        new ExecutorError(
          "NOT_CONNECTED",
          "Open AgentBridgeMac.app and connect it to this Bridge.",
        ),
      );
    if (signal?.aborted)
      return Promise.reject(
        new ExecutorError("CANCELLED", "Request already cancelled."),
      );
    if (this.pending.size >= (tool === "mac_stop" ? 33 : 32))
      return Promise.reject(
        new ExecutorError("BUSY", "Too many pending native requests."),
      );
    if (tool === "mac_stop")
      this.pending.rejectAll(
        new ExecutorError(
          "CANCELLED",
          "Stopped by client; observe before retrying any action.",
        ),
      );
    const request = this.pending.create(ws, {
      timeoutMs: this.options.timeoutMs ?? 35000,
      signal,
      onCancel: (id) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "cancel", id }));
      },
    });
    if (this.pending.has(ws, request.id))
      ws.send(
        JSON.stringify({ type: "request", id: request.id, tool, params }),
        (error) => {
          if (error) this.pending.settle(ws, request.id, error);
        },
      );
    return request.promise;
  }
  async close() {
    clearInterval(this.heartbeat);
    this.pending.rejectAll(
      new ExecutorError("DISCONNECTED", "Bridge shutting down."),
    );
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
