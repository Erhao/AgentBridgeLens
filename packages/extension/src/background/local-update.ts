// The loaded manifest stays in memory until reload; fetching this extension's
// manifest reads its current installation directory instead. No Bridge needed.
export const LOCAL_UPDATE_ALARM = "bridgelens-local-update";

export function startLocalUpdateChecks(isBusy: () => boolean): void {
  const running = chrome.runtime.getManifest();
  let checking = false;

  async function check(): Promise<void> {
    if (checking || isBusy()) return;
    checking = true;
    try {
      // A unique URL plus no-store avoids stale extension-resource responses.
      const url = chrome.runtime.getURL("manifest.json") + `?local-update=${crypto.randomUUID()}`;
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const disk = await response.json();
      if (!disk || disk.manifest_version !== running.manifest_version || disk.name !== running.name ||
          (disk.key ?? "") !== (running.key ?? "") || typeof disk.version !== "string" ||
          !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(disk.version) ||
          disk.version.split(".").some((part: string) => Number(part) > 65535) ||
          !disk.version.split(".").some((part: string) => Number(part) > 0) ||
          disk.version === running.version) return;
      // Work may have started while the disk read was pending. A downgrade from
      // updater --rollback is also a change and must activate in the same way.
      if (!isBusy()) chrome.runtime.reload();
    } catch {
      // A missing directory during the updater's switch, unreadable/partial
      // JSON or a timeout must leave the running extension alone. Retry later.
    } finally {
      checking = false;
    }
  }

  // Register synchronously so an alarm can wake a suspended MV3 worker.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LOCAL_UPDATE_ALARM) void check();
  });
  // Do not move the deadline every time another event wakes the worker.
  void chrome.alarms.get(LOCAL_UPDATE_ALARM).then((alarm) => {
    if (!alarm) return chrome.alarms.create(LOCAL_UPDATE_ALARM, { periodInMinutes: 1 });
  }).catch(() => { /* the next worker start retries alarm registration */ });
}
