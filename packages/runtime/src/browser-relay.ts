import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BridgeRequest } from "@agentbridgelens/protocol/browser";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { browserRegistration } from "@agentbridgelens/protocol/browser";
import { executorResponse } from "@agentbridgelens/protocol";
import { PendingRequests } from "./pending.js";
export interface WsRelayOptions {
  port: number;
  host?: string;
  token?: string;
}
export class WsRelay {
  private wss: WebSocketServer;
  private http: Server;
  private browsers = new Map<string, { ws: WebSocket; name: string; registered: boolean }>();
  private route = new AsyncLocalStorage<{ browserId: string; ws: WebSocket }>();
  // Legacy compatibility pins the first socket, never another browser after disconnect.
  private legacyId?: string;
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
      let browserId = `legacy-${randomUUID()}`;
      let registered = false;
      this.browsers.set(browserId, { ws, name: "Legacy Chrome (unregistered)", registered: false });
      this.legacyId ??= browserId;
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
          const parsed: unknown = JSON.parse(raw.toString());
          if (parsed && typeof parsed === "object" && "t" in parsed && parsed.t === "register_browser") {
            const hello = browserRegistration.safeParse(parsed);
            if (registered || !hello.success) {
              ws.close(1008, "Invalid browser registration");
              return;
            }
            const existing = this.browsers.get(hello.data.browserId);
            if (existing && existing.ws.readyState === WebSocket.OPEN) {
              ws.close(1008, "Browser ID already connected");
              return;
            }
            this.browsers.delete(browserId);
            browserId = hello.data.browserId;
            registered = true;
            this.browsers.set(browserId, { ws, name: hello.data.name, registered: true });
            ws.send(JSON.stringify({ t: "browser_registered", protocolVersion: 2, browserId }));
            return;
          }
          const msg = executorResponse.safeParse(parsed);
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
        // Offline identities remain visible; closing an old socket cannot affect a new one.
        if (!registered && browserId !== this.legacyId) this.browsers.delete(browserId);
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
  listBrowsers() {
    return [...this.browsers].map(([browserId, item]) => ({
      browserId, name: item.name, registered: item.registered,
      connected: item.ws.readyState === WebSocket.OPEN,
    }));
  }
  private target(browserId?: string) {
    const id = browserId ?? this.legacyId;
    const browser = id ? this.browsers.get(id) : undefined;
    if (!browser || browser.ws.readyState !== WebSocket.OPEN) {
      throw new Error(browserId
        ? `Browser '${browserId}' is offline or unknown; no other browser was selected.`
        : "Chrome extension not connected or browserId required. Call list_browsers and select a browserId.");
    }
    if (!browserId && (browser.registered || this.listBrowsers().filter(b => b.connected).length !== 1)) {
      throw new Error("browserId required. Call list_browsers; multiple browsers must never share a default target.");
    }
    return { browserId: id!, ws: browser.ws };
  }
  withBrowser<T>(browserId: string | undefined, run: () => T): T {
    return this.route.run(this.target(browserId), run);
  }
  get connected() {
    return this.listBrowsers().some(browser => browser.connected);
  }
  async send(
    tool: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const selected = this.route.getStore() ?? this.target();
    const ws = selected.ws;
    if (ws.readyState !== WebSocket.OPEN || this.browsers.get(selected.browserId)?.ws !== ws)
      throw new Error(`Browser '${selected.browserId}' disconnected during this call; observe before retrying.`);
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
