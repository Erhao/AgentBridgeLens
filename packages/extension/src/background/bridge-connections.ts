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
        clearTimeout(connection.retry);
        connection.controller?.abort();
        if (connection.socket) {
          connection.socket.onclose = null;
          connection.socket.close();
        }
      } else {
        // Presentation changes must not interrupt a socket or in-flight calls.
        connection.profile = profile;
      }
    }
    for (const [id, profile] of desired) {
      if (!this.connections.has(id)) this.connections.set(id, { profile });
      this.connect(this.connections.get(id)!);
    }
  }

  status() {
    return [...this.connections.values()].map(({ profile, socket }) => ({
      id: profile.id, name: profile.name, url: this.url(profile),
      connected: socket?.readyState === WebSocket.OPEN,
    }));
  }

  private url(profile: BridgeProfile) {
    const host = profile.host.includes(":") && !profile.host.startsWith("[") ? `[${profile.host}]` : profile.host;
    return `ws://${host}:${profile.port}`;
  }

  private connect(connection: Connection) {
    if (connection.socket || connection.retry) return;
    const { profile } = connection;
    const url = this.url(profile);
    let socket: WebSocket;
    try {
      socket = new WebSocket(profile.token ? `${url}?token=${encodeURIComponent(profile.token)}` : url);
    } catch {
      this.retry(connection);
      return;
    }
    connection.socket = socket;
    const controller = new AbortController();
    connection.controller = controller;
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
    socket.onclose = () => {
      controller.abort();
      if (connection.socket !== socket) return;
      connection.socket = undefined;
      this.retry(connection);
    };
    socket.onerror = () => socket.close();
  }

  private retry(connection: Connection) {
    if (this.connections.get(connection.profile.id) !== connection || connection.retry) return;
    connection.retry = setTimeout(() => {
      connection.retry = undefined;
      this.connect(connection);
    }, 3000);
  }
}
