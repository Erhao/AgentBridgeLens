/** Display operation metadata and bounded structural summaries, never raw payloads. */
export interface Activity {
  id: string;
  tool: string;
  dimension: string;
  action?: string;
  aiDescription?: string;
  outcome?: string;
  scope: string;
  bridgeName: string;
  bridgeId?: string;
  bridgeColor?: string;
  sequence?: number;
  tabId?: number;
  windowId?: number;
  page?: string;
  site?: string;
  state: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
}

const dimensions: Record<string, string> = {
  list_tabs: "标签页管理", set_target_tab: "标签页管理", get_target_tab: "标签页管理", clear_target_tab: "标签页管理",
  request_user_confirmation: "等待用户确认",
  get_page_info: "页面信息", get_dom_snapshot: "DOM 结构", inspect_element: "元素与样式", get_element_rect: "元素位置",
  capture_screenshot: "页面截图", execute_js: "页面脚本",
  trace_element_to_source: "组件源码", trace_style_to_source: "样式源码",
  get_console_logs: "控制台日志", get_errors: "页面错误",
  get_network_requests: "网络请求", start_cdp_network: "网络抓包", stop_cdp_network: "网络抓包", get_cdp_network: "网络请求",
  get_performance_metrics: "性能指标", get_accessibility_tree: "无障碍结构",
  highlight_element: "元素高亮", clear_highlights: "元素高亮", mark_elements: "元素标记",
  visualize_layout: "页面布局", show_responsive_frame: "响应式布局", clear_overlays: "页面覆盖层",
  start_recording: "操作录制", stop_recording: "操作录制", replay_actions: "操作回放",
  show_hud: "页面提示", hide_hud: "页面提示", update_hud: "页面提示",
};

const actions: Record<string, string> = {
  list_tabs: "查看打开的标签页", set_target_tab: "固定操作目标页", get_target_tab: "查看默认操作目标", clear_target_tab: "取消固定目标页",
  request_user_confirmation: "等待用户确认下一步",
  get_page_info: "读取页面标题、元信息与视口", get_dom_snapshot: "读取页面或指定区域的结构", inspect_element: "检查目标元素的属性、样式与位置", get_element_rect: "读取目标元素的位置和尺寸",
  capture_screenshot: "截取当前页面画面", execute_js: "执行页面脚本",
  trace_element_to_source: "查找目标元素对应的组件源码", trace_style_to_source: "查找目标元素的样式来源",
  get_console_logs: "读取捕获的控制台日志", get_errors: "读取捕获的页面错误",
  get_network_requests: "读取已捕获的网络请求", start_cdp_network: "开启完整网络请求采集", stop_cdp_network: "停止完整网络请求采集", get_cdp_network: "读取完整网络采集记录",
  get_performance_metrics: "读取加载、绘制与内存指标", get_accessibility_tree: "读取页面的无障碍结构",
  highlight_element: "高亮目标元素", clear_highlights: "清除元素高亮", mark_elements: "标记指定的一组元素",
  visualize_layout: "检查页面内容被裁切的位置", show_responsive_frame: "显示指定宽度的布局参考框", clear_overlays: "清除页面上的辅助标记",
  start_recording: "开始录制页面交互", stop_recording: "停止录制并读取操作记录", replay_actions: "回放指定的页面操作序列",
  show_hud: "显示页面提示面板", hide_hud: "隐藏页面提示面板", update_hud: "更新页面提示文字",
};

function displayText(value: string, limit = 160): string {
  return value.replace(/[\r\n\t]+/g, " ")
    .replace(/(\[(?:value|data-token|data-secret|data-password)\s*[*^$|~]?=\s*)(?:"[^"]*"|'[^']*'|[^\]]+)/gi, "$1[已隐藏]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [已隐藏]")
    .replace(/((?:token|password|secret|authorization|cookie|api[-_]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[已隐藏]").slice(0, limit);
}

export function describeActivity(tool: string, params: Record<string, unknown>) {
  const scope: string[] = [];
  for (const [key, label] of [["selector", "元素"], ["property", "属性"], ["level", "日志级别"], ["status", "状态码"], ["width", "宽度"]]) {
    if (typeof params[key] === "string" || typeof params[key] === "number") {
      scope.push(`${label}：${displayText(String(params[key]))}`);
    }
  }
  if (Array.isArray(params.selectors)) scope.push(`元素数量：${params.selectors.length}`);
  if (params.maxDepth !== undefined) scope.push(`结构深度：${displayText(String(params.maxDepth))}`);
  if (params.limit !== undefined) scope.push(`最多返回：${displayText(String(params.limit))} 条`);
  if (Array.isArray(params.actions)) scope.push(`回放步骤：${params.actions.length}`);
  if (params.urlPattern) {
    let filter = "已设置 URL 筛选";
    if (typeof params.urlPattern === "string") {
      try {
        const url = new URL(params.urlPattern);
        if (["http:", "https:"].includes(url.protocol)) filter = displayText(url.origin + url.pathname);
      } catch {
        if (params.urlPattern.startsWith("/")) filter = displayText(params.urlPattern.split(/[?#]/)[0]);
      }
    }
    scope.push(`网络范围：${filter}`);
  }
  const aiDescription = tool === "execute_js" && typeof params.activity === "string" ? displayText(params.activity.trim(), 80) : "";
  return { dimension: dimensions[tool] ?? "页面操作", scope: scope.join(" · "),
    action: tool === "capture_screenshot" && params.selector ? "截取指定元素的画面" : actions[tool] ?? "执行页面操作",
    ...(aiDescription ? { aiDescription } : {}),
  };
}

export function formatActivity(activity: Activity): string {
  const state = { running: "正在执行", completed: "已完成", failed: "执行失败" }[activity.state];
  const duration = activity.finishedAt === undefined ? "" : ` · ${((activity.finishedAt - activity.startedAt) / 1000).toFixed(1)} 秒`;
  return [
    `${state} · ${activity.action ?? activity.dimension}${duration}`,
    activity.aiDescription ? `AI 说明：${activity.aiDescription}` : undefined,
    `服务：${activity.bridgeName}`,
    activity.tabId === undefined ? "范围：浏览器管理" : `页面：${activity.page || "正在解析目标页面"}（标签页 ${activity.tabId}）`,
    activity.site, activity.scope, activity.outcome ? `结果：${activity.outcome}` : undefined, `工具：${activity.tool}`,
  ].filter(Boolean).join("\n");
}

export function formatActivityCard(activity: Activity): string {
  const state = { running: "正在执行", completed: "已完成", failed: "执行失败" }[activity.state];
  const duration = activity.finishedAt === undefined ? "" : ` · ${((activity.finishedAt - activity.startedAt) / 1000).toFixed(1)} 秒`;
  return [
    `${state} · ${activity.action ?? activity.dimension}${duration}`,
    activity.aiDescription ? `AI 说明：${activity.aiDescription}` : undefined,
    `服务：${activity.bridgeName}`,
    activity.page ? `页面：${activity.page}` : undefined,
    activity.site,
    activity.scope ? `范围：${activity.scope}` : undefined,
    activity.outcome ? `结果：${activity.outcome}` : undefined,
  ].filter(Boolean).join("\n");
}

export interface ActivitySnapshot {
  windowId?: number;
  active: Activity[];
  last?: Activity;
  recent?: Activity[];
  revision?: number;
}

/** Page overlays receive only activity belonging to their own Chrome window. */
export function activitiesForWindow(snapshot: ActivitySnapshot, windowId: number): ActivitySnapshot {
  windowId = Number.isInteger(windowId) && windowId >= 0 ? windowId : -1;
  const matches = (activity: Activity) => windowId >= 0 && activity.windowId === windowId;
  const recent = (snapshot.recent ?? []).filter(matches);
  return {
    windowId, revision: snapshot.revision, active: snapshot.active.filter(matches), recent,
    last: snapshot.last && matches(snapshot.last) ? snapshot.last : recent.at(-1),
  };
}

/** One card per call, ordered by creation, with independent completion deadlines. */
export function visibleActivities(snapshot: ActivitySnapshot, seconds: number, now = Date.now()): Activity[] {
  const unique = new Map<string, Activity>();
  for (const activity of [...(snapshot.recent ?? []), ...(snapshot.last ? [snapshot.last] : []), ...snapshot.active]) unique.set(activity.id, activity);
  return [...unique.values()].filter((activity) => activity.state === "running" ||
    (activity.finishedAt !== undefined && activity.finishedAt + seconds * 1000 > now))
    .sort((a, b) => a.startedAt - b.startedAt || (a.sequence ?? 0) - (b.sequence ?? 0));
}

/** Hover pins survive metadata eviction; dismissing one call never disables others. */
export class ActivityToastState {
  private snapshot: ActivitySnapshot = { active: [] };
  private pinned = new Map<string, Activity>();
  private dismissed = new Set<string>();

  update(snapshot: ActivitySnapshot) {
    this.snapshot = snapshot;
    const latest = new Map<string, Activity>();
    for (const activity of [...(snapshot.recent ?? []), ...(snapshot.last ? [snapshot.last] : []), ...snapshot.active]) latest.set(activity.id, activity);
    for (const id of this.pinned.keys()) if (latest.has(id)) this.pinned.set(id, latest.get(id)!);
    if (snapshot.windowId !== undefined) {
      for (const [id, activity] of this.pinned) {
        if (activity.windowId !== snapshot.windowId || (activity.state === "running" && !latest.has(id))) this.pinned.delete(id);
      }
    }
    for (const id of this.dismissed) if (!latest.has(id)) this.dismissed.delete(id);
  }

  pin(id: string) {
    if (this.dismissed.has(id) || this.pinned.has(id)) return;
    const activity = [...this.snapshot.active, ...(this.snapshot.last ? [this.snapshot.last] : []), ...(this.snapshot.recent ?? [])].find((item) => item.id === id);
    if (activity) this.pinned.set(id, activity);
  }

  isPinned(id: string) { return this.pinned.has(id); }
  dismiss(id: string) { this.pinned.delete(id); this.dismissed.add(id); }
  dismissAll(seconds: number, now = Date.now()) {
    for (const activity of this.visible(seconds, now)) this.dismiss(activity.id);
  }
  resetInteraction() { this.pinned.clear(); this.dismissed.clear(); }

  visible(seconds: number, now = Date.now()): Activity[] {
    const visible = new Map(visibleActivities(this.snapshot, seconds, now).map((activity) => [activity.id, activity]));
    for (const [id, activity] of this.pinned) visible.set(id, activity);
    return [...visible.values()].filter((activity) => !this.dismissed.has(activity.id))
      .sort((a, b) => a.startedAt - b.startedAt || (a.sequence ?? 0) - (b.sequence ?? 0));
  }
}
