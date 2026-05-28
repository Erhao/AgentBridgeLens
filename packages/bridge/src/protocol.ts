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

export interface BridgeEvent {
  event: string;
  data: unknown;
}

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent;

export function isRequest(msg: BridgeMessage): msg is BridgeRequest {
  return "tool" in msg && "id" in msg;
}

export function isResponse(msg: BridgeMessage): msg is BridgeResponse {
  return "id" in msg && !("tool" in msg);
}

export function isEvent(msg: BridgeMessage): msg is BridgeEvent {
  return "event" in msg;
}
