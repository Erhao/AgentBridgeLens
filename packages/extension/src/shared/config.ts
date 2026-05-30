export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19222;

export interface BridgeConfig {
  host: string;
  port: number;
}

export async function getBridgeConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  return {
    host: typeof stored.bridgeHost === "string" && stored.bridgeHost ? stored.bridgeHost : DEFAULT_HOST,
    port: typeof stored.bridgePort === "number" && stored.bridgePort > 0 ? stored.bridgePort : DEFAULT_PORT,
  };
}

export async function setBridgeConfig(config: BridgeConfig): Promise<void> {
  await chrome.storage.local.set({ bridgeHost: config.host, bridgePort: config.port });
}
