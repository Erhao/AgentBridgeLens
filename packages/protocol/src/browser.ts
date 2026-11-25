import { z } from "zod";

/** Registration is sent before responses; IDs identify installations, not tabs. */
export const browserRegistration = z.object({
  t: z.literal("register_browser"),
  protocolVersion: z.literal(2),
  browserId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
});
export type BrowserIdentity = Pick<z.infer<typeof browserRegistration>, "browserId" | "name">;

/** Browser request/response wire remains compatible with installed extensions. */
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
