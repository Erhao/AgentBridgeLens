/** Display metadata only: never include JS source, request bodies or tool results. */
export interface Activity {
  id: string;
  tool: string;
  dimension: string;
  scope: string;
  bridgeName: string;
  bridgeId?: string;
  bridgeColor?: string;
  sequence?: number;
  tabId?: number;
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

export function describeActivity(tool: string, params: Record<string, unknown>) {
  const scope: string[] = [];
  for (const [key, label] of [["selector", "元素"], ["property", "属性"], ["level", "日志级别"], ["status", "状态码"], ["width", "宽度"]]) {
    if (typeof params[key] === "string" || typeof params[key] === "number") {
      scope.push(`${label}：${String(params[key]).slice(0, 160)}`);
    }
  }
  if (Array.isArray(params.selectors)) scope.push(`元素数量：${params.selectors.length}`);
  if (params.urlPattern) scope.push("网络范围：已设置 URL 筛选");
  return { dimension: dimensions[tool] ?? "页面操作", scope: scope.join(" · ") };
}

export function formatActivity(activity: Activity): string {
  const state = { running: "正在执行", completed: "已完成", failed: "执行失败" }[activity.state];
  const duration = activity.finishedAt === undefined ? "" : ` · ${((activity.finishedAt - activity.startedAt) / 1000).toFixed(1)} 秒`;
  return [
    `${state} · ${activity.dimension}${duration}`,
    `服务：${activity.bridgeName}`,
    activity.tabId === undefined ? "范围：浏览器管理" : `页面：${activity.page || "正在解析目标页面"}（标签页 ${activity.tabId}）`,
    activity.site, activity.scope, `工具：${activity.tool}`,
  ].filter(Boolean).join("\n");
}

export interface ActivitySnapshot {
  active: Activity[];
  last?: Activity;
  recent?: Activity[];
  revision?: number;
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
    for (const id of this.dismissed) if (!latest.has(id)) this.dismissed.delete(id);
  }

  pin(id: string) {
    if (this.dismissed.has(id) || this.pinned.has(id)) return;
    const activity = [...this.snapshot.active, ...(this.snapshot.last ? [this.snapshot.last] : []), ...(this.snapshot.recent ?? [])].find((item) => item.id === id);
    if (activity) this.pinned.set(id, activity);
  }

  isPinned(id: string) { return this.pinned.has(id); }
  dismiss(id: string) { this.pinned.delete(id); this.dismissed.add(id); }
  resetInteraction() { this.pinned.clear(); this.dismissed.clear(); }

  visible(seconds: number, now = Date.now()): Activity[] {
    const visible = new Map(visibleActivities(this.snapshot, seconds, now).map((activity) => [activity.id, activity]));
    for (const [id, activity] of this.pinned) visible.set(id, activity);
    return [...visible.values()].filter((activity) => !this.dismissed.has(activity.id))
      .sort((a, b) => a.startedAt - b.startedAt || (a.sequence ?? 0) - (b.sequence ?? 0));
  }
}
