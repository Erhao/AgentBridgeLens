import type { BrowserIdentity } from "@agentbridgelens/protocol/browser";

let identity: Promise<BrowserIdentity> | undefined;
/** Local storage survives MV3 restarts; sync storage would clone IDs onto other machines. */
export function getBrowserIdentity(): Promise<BrowserIdentity> {
  return identity ??= (async () => {
    const stored = await chrome.storage.local.get("browserIdentity");
    const value = stored.browserIdentity;
    if (value && typeof value.browserId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.browserId) &&
        typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100)
      return { browserId: value.browserId, name: value.name.trim() };
    const browserId = crypto.randomUUID();
    const created = { browserId, name: `Chrome ${navigator.platform} ${browserId.slice(0, 8)}` };
    await chrome.storage.local.set({ browserIdentity: created });
    return created;
  })().catch((error) => { identity = undefined; throw error; });
}
