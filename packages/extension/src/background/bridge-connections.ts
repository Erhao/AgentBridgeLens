import type { BridgeProfile } from "../shared/config";
import type { BridgeRequest, BridgeResponse } from "../shared/protocol";

export interface BridgeSource {
  id: string;
  name: string;
  url: string;
  signal: AbortSignal;
}

interface Connection {
  profile: BridgeProfile;
  socket?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  diagnostic?: AbortController;
  attempts: number;
  lastAttemptAt?: number;
  connectedAt?: number;
  nextRetryAt?: number;
  lastError?: string;
}

export interface BridgeStatus {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  state: "connecting" | "connected" | "retrying";
  attempts: number;
  lastAttemptAt?: number;
  connectedAt?: number;
  nextRetryAt?: number;
  lastError?: string;
}

/** Each socket owns its replies and retry timer, including across reconnects. */
export class BridgeConnections {
  private connections = new Map<string, Connection>();

  constructor(private handle: (request: BridgeRequest, source: BridgeSource) => Promise<unknown>) {}

  update(profiles: BridgeProfile[], consent: boolean) {
    const desired = new Map(profiles.filter((p) => consent && p.enabled).map((p) => [p.id, p]));
    for (const [id, connection] of this.connections) {
      const profile = desired.get(id);
      if (!profile || profile.host !== connection.profile.host || profile.port !== connection.profile.port || profile.token !== connection.profile.token) {
        this.connections.delete(id);
        this.close(connection);
      } else {
        // Presentation changes must not interrupt a socket or in-flight calls.
        connection.profile = profile;
      }
    }
    for (const [id, profile] of desired) {
      if (!this.connections.has(id)) this.connections.set(id, { profile, attempts: 0 });
      this.connect(this.connections.get(id)!);
    }
  }

  status(): BridgeStatus[] {
    return [...this.connections.values()].map(({ profile, socket, retry, attempts, lastAttemptAt, connectedAt, nextRetryAt, lastError }) => ({
      id: profile.id, name: profile.name, url: this.url(profile),
      connected: socket?.readyState === WebSocket.OPEN,
      state: socket?.readyState === WebSocket.OPEN ? "connected" : retry ? "retrying" : "connecting",
      attempts, lastAttemptAt, connectedAt, nextRetryAt, lastError,
    }));
  }

  reconnect(id: string): boolean {
    const connection = this.connections.get(id);
    if (!connection) return false;
    this.close(connection);
    this.connect(connection);
    return true;
  }

  private close(connection: Connection) {
    clearTimeout(connection.retry);
    clearTimeout(connection.timeout);
    connection.retry = undefined;
    connection.timeout = undefined;
    connection.nextRetryAt = undefined;
    connection.controller?.abort();
    connection.diagnostic?.abort();
    const socket = connection.socket;
    connection.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
  }

  private url(profile: BridgeProfile) {
    const host = profile.host.includes(":") && !profile.host.startsWith("[") ? `[${profile.host}]` : profile.host;
    return `ws://${host}:${profile.port}`;
  }

  private connect(connection: Connection) {
    if (connection.socket || connection.retry) return;
    connection.diagnostic?.abort();
    connection.attempts++;
    connection.lastAttemptAt = Date.now();
    const { profile } = connection;
    const url = this.url(profile);
    let socket: WebSocket;
    try {
      socket = new WebSocket(profile.token ? `${url}?token=${encodeURIComponent(profile.token)}` : url);
    } catch {
      // Constructor errors can contain the URL (and token). Never expose them.
      connection.lastError = "无法创建 WebSocket 连接，请检查 Host / Port 和浏览器权限。";
      this.retry(connection);
      return;
    }
    connection.socket = socket;
    const controller = new AbortController();
    connection.controller = controller;
    let opened = false;
    const fail = (message: string, diagnose = false) => {
      if (connection.socket !== socket) return;
      this.close(connection);
      connection.lastError = message;
      this.retry(connection);
      if (diagnose) void this.diagnose(connection);
    };
    connection.timeout = setTimeout(() => fail("连接超时（10 秒），请检查服务、网络和浏览器站点访问权限。"), 10_000);
    socket.onopen = () => {
      if (connection.socket !== socket) return;
      opened = true;
      clearTimeout(connection.timeout);
      connection.timeout = undefined;
      connection.connectedAt = Date.now();
      connection.lastError = undefined;
    };
    socket.onmessage = async (event) => {
      let request: BridgeRequest;
      try {
        const parsed = JSON.parse(event.data as string);
        if (parsed?.t === "ping") return;
        if (!parsed || typeof parsed.id !== "string" || typeof parsed.tool !== "string" ||
            !parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)) return;
        request = parsed;
      } catch { return; }
      if (controller.signal.aborted) return;
      let response: BridgeResponse;
      try {
        response = { id: request.id, result: await this.handle(request, { id: connection.profile.id, name: connection.profile.name, url, signal: controller.signal }) };
      } catch (error) {
        response = { id: request.id, error: { message: error instanceof Error ? error.message : String(error) } };
      }
      // Never send an old request's result on a replacement socket.
      if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(response));
      }
    };
    socket.onclose = (event) => {
      const code = event?.code ? `（关闭码 ${event.code}）` : "";
      fail(opened ? `连接已断开${code}，正在自动重连。` : `WebSocket 握手失败${code}，正在诊断…`, !opened);
    };
    socket.onerror = () => fail(opened ? "连接发生网络错误，正在自动重连。" : "WebSocket 握手失败，正在诊断…", !opened);
  }

  /** Browser WebSocket errors hide HTTP status. Probe HTTP separately without putting secrets in URLs. */
  private async diagnose(connection: Connection) {
    const controller = new AbortController();
    connection.diagnostic = controller;
    const timeout = setTimeout(() => controller.abort(), 2000);
    const attempt = connection.attempts;
    let message: string;
    try {
      const response = await fetch(`${this.url(connection.profile).replace(/^ws:/, "http:")}/health`, {
        headers: connection.profile.token ? { Authorization: `Bearer ${connection.profile.token}` } : {},
        signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error",
      });
      if (response.status === 401) {
        message = "HTTP 401：鉴权失败，请核对 Token 与服务端 BRIDGELENS_TOKEN 是否一致。";
      } else if (response.status === 404 || response.status === 426) {
        message = "WebSocket 握手失败；服务可能是旧版，或端口不是桥接服务，无法确认鉴权结果。请更新 Bridge 或查看扩展后台控制台。";
      } else if (response.ok && (await response.json()).service === "AgentBridgeLens") {
        message = "服务可达且 Token 验证通过，但 WebSocket 握手失败，请检查代理是否支持 WebSocket。";
      } else {
        message = `WebSocket 握手失败；诊断接口返回 HTTP ${response.status}，请确认端口是否属于 AgentBridgeLens。`;
      }
    } catch {
      message = "WebSocket 握手失败，且无法访问诊断接口：请检查服务、网络、代理及扩展站点访问权限；尚无法确认是否为 Token 问题。";
    } finally {
      clearTimeout(timeout);
    }
    if (this.connections.get(connection.profile.id) === connection && connection.attempts === attempt && connection.retry) {
      connection.lastError = message;
    }
  }

  private retry(connection: Connection) {
    if (this.connections.get(connection.profile.id) !== connection || connection.retry) return;
    connection.nextRetryAt = Date.now() + 3000;
    connection.retry = setTimeout(() => {
      connection.retry = undefined;
      connection.nextRetryAt = undefined;
      this.connect(connection);
    }, 3000);
  }
}
