import { WebSocketServer, WebSocket } from "ws";
import type { BridgeRequest, BridgeResponse } from "./protocol.js";

export class WsRelay {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });

    this.wss.on("connection", (ws) => {
      this.client = ws;
      console.error(`[BridgeLens] Extension connected`);

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
        this.client = null;
        console.error(`[BridgeLens] Extension disconnected`);
        for (const [id, { reject }] of this.pending) {
          reject(new Error("Extension disconnected"));
          this.pending.delete(id);
        }
      });
    });

    console.error(`[BridgeLens] WebSocket server listening on 127.0.0.1:${port}`);
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
