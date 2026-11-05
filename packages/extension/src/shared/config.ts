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
  color?: string;
}

export const DEFAULT_TOAST_SECONDS = 2;
export const MAX_TOAST_SECONDS = 300;
export const BRIDGE_COLORS = ["#60a5fa", "#c084fc", "#fb923c", "#2dd4bf", "#f472b6", "#facc15", "#a3e635", "#f87171"];

export function isBridgeColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function toastSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOAST_SECONDS ? value : DEFAULT_TOAST_SECONDS;
}

/** Preserve explicit colors; give old/new profiles distinct automatic accents. */
export function withBridgeColors(profiles: BridgeProfile[]): BridgeProfile[] {
  const used = new Set(profiles.filter((p) => isBridgeColor(p.color)).map((p) => p.color!.toLowerCase()));
  let index = 0;
  return profiles.map((profile) => {
    let color = isBridgeColor(profile.color) ? profile.color.toLowerCase() : undefined;
    if (!isBridgeColor(color)) {
      do {
        color = BRIDGE_COLORS[index] ?? `#${((0x5fa8d3 + (index - BRIDGE_COLORS.length) * 0x9e3779) & 0xffffff).toString(16).padStart(6, "0")}`;
        index++;
      } while (used.has(color));
      used.add(color);
    }
    return { ...profile, color };
  });
}

export async function getBridgeProfiles(): Promise<BridgeProfile[]> {
  const { bridgeProfiles } = await chrome.storage.local.get("bridgeProfiles");
  // An empty list intentionally means no configured services.
  if (Array.isArray(bridgeProfiles)) return withBridgeColors(bridgeProfiles);
  return withBridgeColors([{ ...await getBridgeConfig(), id: "default", name: "默认服务", enabled: true }]);
}

export async function setBridgeProfiles(profiles: BridgeProfile[]): Promise<void> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id || ids.has(profile.id)) throw new Error("服务编号重复");
    ids.add(profile.id);
    if (profile.color !== undefined && !isBridgeColor(profile.color)) throw new Error("强调色必须是有效的六位十六进制颜色");
    if (!profile.host.trim() || /[\s/?#@]/.test(profile.host)) throw new Error("Host 请只填写主机名或 IP，不含协议和路径");
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error("端口必须在 1 到 65535 之间");
  }
  const addresses = profiles.filter((p) => p.enabled).map((p) => `${p.host.toLowerCase()}:${p.port}`);
  if (new Set(addresses).size !== addresses.length) throw new Error("同一服务地址只能启用一次");
  await chrome.storage.local.set({ bridgeProfiles: withBridgeColors(profiles) });
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
