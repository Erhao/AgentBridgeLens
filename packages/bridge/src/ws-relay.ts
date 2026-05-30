import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { BridgeRequest, BridgeResponse } from "./protocol.js";

export interface WsRelayOptions {
  port: number;
  /** Bind address. Use 0.0.0.0 to allow a Chrome extension on another machine to connect. */
  host?: string;
  /** Shared secret the extension must present as ?token=… . Strongly recommended when host != 127.0.0.1. */
  token?: string;
}

export class WsRelay {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private token?: string;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(options: WsRelayOptions) {
    const host = options.host || "127.0.0.1";
    this.token = options.token;
    this.wss = new WebSocketServer({
      port: options.port,
      host,
      // Reject unauthorized clients during the HTTP upgrade, before the WS
      // handshake completes — so a bad token never reaches an open socket.
      verifyClient: (info, done) => {
        if (this.authorize(info.req)) return done(true);
        console.error(`[BridgeLens] Rejected connection from ${info.req.socket.remoteAddress}: invalid token`);
        done(false, 401, "Unauthorized");
      },
    });

    this.wss.on("connection", (ws, req: IncomingMessage) => {
      this.client = ws;
      console.error(`[BridgeLens] Extension connected from ${req.socket.remoteAddress}`);

      // 应用层心跳：每 20s 发一条数据消息。MV3 Service Worker 收到 WS 消息会重置其
      // ~30s 空闲计时器，从而保持唤醒、连接常驻。必须是数据消息（onmessage 触发），
      // 协议级 ws.ping() 由浏览器透明处理、不触发 onmessage，起不到保活作用。
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "ping" }));
        }
      }, 20_000);

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as BridgeResponse;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      });

      ws.on("close", () => {
        clearInterval(heartbeat);
        this.client = null;
        console.error(`[BridgeLens] Extension disconnected`);
        for (const [id, { reject }] of this.pending) {
          reject(new Error("Extension disconnected"));
          this.pending.delete(id);
        }
      });
    });

    const authNote = this.token ? "token required" : "no token";
    if (host !== "127.0.0.1" && !this.token) {
      console.error(
        `[BridgeLens] WARNING: listening on ${host}:${options.port} with no BRIDGELENS_TOKEN — the browser-control channel is exposed to the network unauthenticated.`
      );
    }
    console.error(`[BridgeLens] WebSocket server listening on ${host}:${options.port} (${authNote})`);
  }

  /** Validate the connecting extension's ?token= query against the configured token. */
  private authorize(req: IncomingMessage): boolean {
    if (!this.token) return true;
    let provided: string | null = null;
    try {
      provided = new URL(req.url ?? "/", "ws://localhost").searchParams.get("token");
    } catch {
      provided = null;
    }
    return provided === this.token;
  }

  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  async send(tool: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Chrome extension not connected. Please open Chrome with the AgentBridgeLens extension installed."
      );
    }

    const id = crypto.randomUUID();
    const request: BridgeRequest = { id, tool, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool '${tool}' timed out after 120s`));
      }, 120_000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.client!.send(JSON.stringify(request));
    });
  }

  close() {
    this.wss.close();
  }
}
