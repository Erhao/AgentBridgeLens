/** Restore packaged content scripts after an extension reload, without navigation. */
export class ContentConnection {
  private pending = new Map<number, Promise<void>>();
  private failed = new Map<number, { until: number; message: string }>();

  private async ready(tabId: number): Promise<boolean> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "bridgelens-content-ping" }, { frameId: 0 });
      return response?.ready === true && response.version === chrome.runtime.getManifest().version;
    } catch { return false; }
  }

  ensure(tabId: number): Promise<void> {
    const pending = this.pending.get(tabId);
    if (pending) return pending;
    for (const [id, failure] of this.failed) if (failure.until <= Date.now()) this.failed.delete(id);
    const task = this.restore(tabId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.failed.has(tabId)) this.failed.set(tabId, { until: Date.now() + 2000, message });
      throw error;
    }).finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, task);
    return task;
  }

  private async restore(tabId: number): Promise<void> {
    if (await this.ready(tabId)) { this.failed.delete(tabId); return; }
    const failure = this.failed.get(tabId);
    if (failure && failure.until > Date.now()) throw new Error(failure.message);
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//i.test(tab.url ?? "")) throw new Error("此页面不支持网页脚本，请切换到普通 HTTP/HTTPS 网页");
    const files = chrome.runtime.getManifest().content_scripts?.flatMap((script) => script.js ?? []) ?? [];
    if (!files.length) throw new Error("扩展缺少网页脚本，请重新加载或更新扩展");
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files });
    } catch {
      throw new Error("网页脚本无法恢复，请检查扩展的站点访问权限，或刷新该网页后重试");
    }
    // The packaged Vite loader imports asynchronously, after executeScript returns.
    for (const delay of [0, 50, 100, 200, 400, 800, 1000, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await this.ready(tabId)) { this.failed.delete(tabId); return; }
    }
    throw new Error("网页脚本未能启动，请刷新该网页；若仍失败，请查看扩展错误信息");
  }

  async sendActivity(tabId: number, message: unknown): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      await this.ensure(tabId);
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    }
  }

  forget(tabId: number) { this.failed.delete(tabId); }
}
