import type { DesktopPlatform } from "@agentbridgelens/protocol";
export interface DesktopExecutor {
  readonly platform: DesktopPlatform;
  send(
    tool: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any>;
  close(): void;
  stopAndClose(): Promise<void>;
}
