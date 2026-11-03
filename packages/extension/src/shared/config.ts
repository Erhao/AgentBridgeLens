export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19222;
export const DEFAULT_TOKEN = "";

export interface BridgeConfig {
  host: string;
  port: number;
  /** Shared secret sent to the bridge as ?token=… . Empty = no token (loopback only). */
  token: string;
}

export interface BridgeProfile extends BridgeConfig {
  id: string;
  name: string;
  enabled: boolean;
}

export async function getBridgeProfiles(): Promise<BridgeProfile[]> {
  const { bridgeProfiles } = await chrome.storage.local.get("bridgeProfiles");
  // An empty list intentionally means no configured services.
  if (Array.isArray(bridgeProfiles)) return bridgeProfiles;
  return [{ ...await getBridgeConfig(), id: "default", name: "默认服务", enabled: true }];
}

export async function setBridgeProfiles(profiles: BridgeProfile[]): Promise<void> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id || ids.has(profile.id)) throw new Error("服务编号重复");
    ids.add(profile.id);
    if (!profile.host.trim() || /[\s/?#@]/.test(profile.host)) throw new Error("Host 请只填写主机名或 IP，不含协议和路径");
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error("端口必须在 1 到 65535 之间");
  }
  const addresses = profiles.filter((p) => p.enabled).map((p) => `${p.host.toLowerCase()}:${p.port}`);
  if (new Set(addresses).size !== addresses.length) throw new Error("同一服务地址只能启用一次");
  await chrome.storage.local.set({ bridgeProfiles: profiles });
}

export async function getBridgeConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get(["bridgeHost", "bridgePort", "bridgeToken"]);
  return {
    host: typeof stored.bridgeHost === "string" && stored.bridgeHost ? stored.bridgeHost : DEFAULT_HOST,
    port: typeof stored.bridgePort === "number" && stored.bridgePort > 0 ? stored.bridgePort : DEFAULT_PORT,
    token: typeof stored.bridgeToken === "string" ? stored.bridgeToken : DEFAULT_TOKEN,
  };
}

export async function setBridgeConfig(config: BridgeConfig): Promise<void> {
  await chrome.storage.local.set({
    bridgeHost: config.host,
    bridgePort: config.port,
    bridgeToken: config.token,
  });
}
