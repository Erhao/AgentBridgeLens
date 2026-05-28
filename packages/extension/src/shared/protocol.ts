export interface BridgeRequest {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  result?: unknown;
  error?: { message: string; code?: string };
}

export interface ContentRequest {
  type: "bridgelens-request";
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ContentResponse {
  type: "bridgelens-response";
  id: string;
  result?: unknown;
  error?: { message: string };
}
