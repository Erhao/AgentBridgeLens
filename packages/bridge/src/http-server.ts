import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import type { WsRelay } from "./ws-relay.js";

export interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  allowedOrigins?: string[];
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}

export async function startHttpServer(relay: WsRelay, options: HttpOptions) {
  const origins = new Set(options.allowedOrigins ?? []);
  const active = new Set<ReturnType<typeof createMcpServer>>();
  const http = createServer(async (req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      reply(res, 404, "Not found");
      return;
    }

    // Non-browser MCP clients normally omit Origin. Browser clients must be
    // explicitly allowed; never reflect arbitrary origins or trust Host for this.
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      reply(res, 403, "Origin not allowed");
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (options.token) {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="AgentBridgeLens"');
        reply(res, 401, "Unauthorized");
        return;
      }
    }
    // Stateless MCP: each POST owns its server and transport. Sharing these
    // between requests can leak responses between clients. Browser state lives
    // in the shared relay/extension, not in the MCP transport.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      reply(res, 405, "Standalone SSE streams and sessions are not supported");
      return;
    }
    const server = createMcpServer(relay);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    active.add(server);
    res.once("close", () => {
      active.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[BridgeLens] HTTP request failed:", error);
      if (!res.headersSent) reply(res, 500, "Internal server error");
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, resolve);
  });
  return {
    address: http.address(),
    async close() {
      await Promise.all([...active].map((server) => server.close()));
      const closed = new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve());
      });
      http.closeAllConnections();
      await closed;
    },
  };
}
