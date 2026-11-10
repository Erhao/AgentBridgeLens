/** Only explicit display summaries and known structural statistics reach the cards. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
}
function treeSize(value: unknown): string {
  const queue: unknown[] = [value], seen = new Set();
  let total = 0;
  while (queue.length && total < 10000) {
    const item = object(queue.pop());
    if (!item.tag || seen.has(item)) continue;
    seen.add(item); total++;
    if (Array.isArray(item.children)) for (const child of item.children.slice(0, 10000 - queue.length)) queue.push(child);
  }
  return `${queue.length ? "至少 " : ""}${total}`;
}

/** This opt-in field is display text, not a dump of the returned object. */
function scriptSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [已隐藏]")
    .replace(/((?:token|password|secret|authorization|cookie|api[-_]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[已隐藏]")
    .trim().slice(0, 160);
}

const resultLabels: Record<string, string> = {
  rowcount: "行数", count: "数量", total: "总数", matchedcount: "匹配数", elementcount: "元素数", requestcount: "请求数", errorcount: "错误数", visiblecount: "可见数",
  storagecount: "存储数量", diskcount: "磁盘数量", volumecount: "卷数量", filecount: "文件数量", foldercount: "目录数量", nodecount: "节点数量", selectedcount: "已选数量", failedcount: "失败数量", successcount: "成功数量", warningcount: "警告数量",
  totalbytes: "总容量", usedbytes: "已用容量", freebytes: "剩余容量", availablebytes: "可用容量", sizebytes: "大小",
  totalcapacity: "总容量", usedcapacity: "已用容量", freecapacity: "剩余容量", totalsize: "总大小", usedsize: "已用大小", freesize: "剩余大小",
  usedpercent: "使用率", usagepercent: "使用率", progresspercent: "进度",
  status: "状态", statuscode: "状态码", state: "状态", view: "视图", mode: "模式", type: "类型",
  loading: "正在加载", ready: "已就绪", enabled: "已启用", disabled: "已禁用", visible: "可见", selected: "已选中", active: "已激活", exists: "存在", empty: "为空", hasdata: "有数据", cansubmit: "可提交", success: "返回成功标志", ok: "返回正常标志",
  rows: "表格行", items: "条目", records: "记录", files: "文件", folders: "目录", disks: "磁盘", storages: "存储", nodes: "节点", requests: "请求", errors: "错误", warnings: "警告", buttons: "按钮", links: "链接", charts: "图表",
  space: "空间", usage: "用量", scan: "扫描", chart: "图表", pagination: "分页", summary: "汇总", capacity: "容量", page: "页码", pagesize: "每页数量", width: "宽度", height: "高度",
};
const resultStates: Record<string, string> = {
  ready: "已就绪", loading: "加载中", pending: "等待中", idle: "空闲", running: "进行中", scanning: "扫描中", queued: "排队中", processing: "处理中", done: "已完成", completed: "已完成", success: "成功", failed: "失败", error: "出错", blocked: "被阻止", cancelled: "已取消", stopped: "已停止", empty: "为空", enabled: "已启用", disabled: "已禁用", visible: "可见", hidden: "隐藏", online: "在线", offline: "离线",
  space: "空间视图", overview: "概览", table: "表格", list: "列表", chart: "图表", tree: "树形视图", scan: "扫描视图",
};
const normalizeKey = (key: string) => key.replace(/[_-]/g, "").toLowerCase();
const privateResultKey = /token|password|passwd|secret|auth|cookie|credential|session|csrf|apikey|accesskey|private|phone|mobile|email|identity|cardnumber|账号|手机号|身份证|headers?|payload|body|html|text|content|message|description|stack|code|raw|凭证|密码|口令|密钥|正文/i;

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${Number(bytes.toFixed(2))} ${units[i]}`;
}

/** Interpret structure, not arbitrary prose. Never walk bodies, credentials or array items. */
function scriptFacts(value: unknown): string[] {
  const facts: string[] = [], seen = new Set<unknown>();
  let visited = 0;
  function walk(value: unknown, path: string[], depth: number) {
    if (depth > 3 || seen.has(value) || visited >= 100 || facts.length >= 6) return;
    const record = object(value);
    seen.add(value);
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (++visited > 100 || facts.length >= 6) break;
      if (key.length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(key)) continue;
      const normalized = normalizeKey(key);
      if (privateResultKey.test(key) && normalized !== "statuscode") continue;
      if (normalized === "activitysummary") continue;
      const label = Object.hasOwn(resultLabels, normalized) ? resultLabels[normalized] : key;
      const item = record[key];
      let detail = "";
      if (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER) {
        if (!Object.hasOwn(resultLabels, normalized) && !/count|bytes|size|capacity|percent|total|used|free|available|duration|length|width|height|progress|index|ms$|容量|数量|大小|已用|剩余|进度|耗时|条数|页码|百分比/.test(normalized)) continue;
        if (normalized.endsWith("bytes") && item >= 0) detail = formatBytes(item);
        else if (normalized.endsWith("percent") && item >= 0 && item <= 100) detail = `${Number(item.toFixed(2))}%`;
        else if (["status", "statuscode"].includes(normalized) && Number.isInteger(item) && item >= 100 && item <= 599) detail = `HTTP ${item}`;
        else detail = String(item);
      } else if (typeof item === "boolean") detail = item ? "是" : "否";
      else if (Array.isArray(item)) detail = `${item.length} 项`;
      else if (typeof item === "string") {
        // Only known status words or unit-bearing measurements are copied from strings.
        if (["status", "state", "view", "mode", "type"].includes(normalized)) detail = Object.hasOwn(resultStates, item.toLowerCase()) ? resultStates[item.toLowerCase()] : "";
        else if (item.length <= 32 && /^(?:total|used|free|available)?(?:capacity|size)$/.test(normalized)
          && /^\d+(?:\.\d+)?\s*(?:B|[KMGTPE]i?B|字节)$/i.test(item.trim())) detail = item.trim();
      }
      if (detail) {
        const location = [...path, label].join(" / ");
        // Keep the established short count wording for existing callers.
        const legacy = depth === 0 && ["rowcount", "count", "total", "matchedcount", "elementcount", "requestcount", "errorcount", "visiblecount"].includes(normalized) && count(item);
        const fact = legacy ? `${location} ${detail}` : `${location}：${detail}`;
        if (facts.join("；").length + fact.length > 320) break;
        facts.push(fact);
      } else if (item && typeof item === "object") {
        walk(item, ["data", "result", "metrics"].includes(normalized) ? path : [...path, label], depth + 1);
      }
    }
  }
  walk(value, [], 0);
  return facts;
}

export function summarizeActivityResult(tool: string, result: unknown, failed = false): string {
  const data = object(result);
  if (failed || data.error !== undefined) {
    const error = typeof data.error === "string" ? data.error.slice(0, 512) : "";
    if (/element not found|no element found/i.test(error)) return "未找到目标元素";
    if (/timeout|超时/i.test(error)) return "网页或工具响应超时";
    if (/permission|cannot access|站点访问权限/i.test(error)) return "无法访问目标页面，请检查站点权限";
    if (/网页脚本|content script|receiving/i.test(error)) return "网页脚本尚未就绪或连接中断";
    for (const kind of ["SyntaxError", "ReferenceError", "TypeError", "RangeError"]) if (new RegExp(`^\\s*(?:Uncaught\\s+)?${kind}(?::|\\b)`).test(error)) return `脚本执行发生 ${kind}`;
    return tool === "execute_js" ? "页面脚本执行出错" : "工具执行失败";
  }
  if (tool === "execute_js") {
    const value = data.value;
    const summary = scriptSummary(object(value).activitySummary);
    if (summary) return summary;
    if (Array.isArray(value)) return `脚本返回 ${value.length} 个条目`;
    const fields = scriptFacts(value);
    return fields.length ? `脚本返回：${fields.join("；")}` : "";
  }
  if (tool === "get_network_requests" || tool === "get_cdp_network") {
    const requests = Array.isArray(result) ? result : Array.isArray(data.requests) ? data.requests : [];
    const errors = requests.filter((entry) => { const item = object(entry); return !!item.failed || (typeof item.status === "number" && (item.status === 0 || item.status >= 400)); });
    const codes = [...new Set(errors.map((entry) => object(entry).status).filter((status) => count(status) && status >= 400 && status <= 599))].slice(0, 4);
    return `读取到 ${requests.length} 条网络记录${errors.length ? `，其中 ${errors.length} 条异常或失败${codes.length ? `（HTTP ${codes.join("、")}）` : ""}` : ""}${data.attached === false ? "；当前未开启 CDP 采集" : ""}`;
  }
  if (tool === "get_console_logs" || tool === "get_errors") {
    const logs = Array.isArray(result) ? result : [];
    const errors = logs.filter((entry) => object(entry).level === "error").length;
    return `读取到 ${logs.length} 条${tool === "get_errors" ? "错误" : "日志"}记录${tool === "get_console_logs" && errors ? `，其中 ${errors} 条错误` : ""}`;
  }
  if (tool === "get_dom_snapshot" || tool === "get_accessibility_tree") return `返回${tool === "get_dom_snapshot" ? "页面" : "无障碍"}结构，含 ${treeSize(result)} 个节点`;
  if (tool === "inspect_element" || tool === "get_element_rect") {
    const rect = tool === "inspect_element" ? object(data.boundingBox) : data;
    const parts = ["已读取目标元素信息"];
    if (number(rect.width) && number(rect.height)) parts.push(`尺寸 ${Math.round(rect.width)} × ${Math.round(rect.height)} px`);
    if (object(data.computedStyle).display === "none") parts.push("display:none");
    if (Object.prototype.hasOwnProperty.call(object(data.attributes), "disabled")) parts.push("存在 disabled 属性");
    return parts.join("；");
  }
  if (tool === "get_page_info") {
    const viewport = object(data.viewport);
    return "已读取页面信息" + (number(viewport.width) && number(viewport.height) ? `；视口 ${viewport.width} × ${viewport.height} px` : "");
  }
  if (tool === "get_performance_metrics") {
    const parts = ["已读取页面性能指标"], nav = object(data.navigation);
    if (number(nav.loadMs)) parts.push(`加载 ${Math.round(nav.loadMs)} ms`);
    if (number(data.firstContentfulPaintMs)) parts.push(`首次内容绘制 ${Math.round(data.firstContentfulPaintMs)} ms`);
    if (count(data.resourceCount)) parts.push(`${data.resourceCount} 条资源记录`);
    return parts.join("；");
  }
  if (tool === "capture_screenshot") return "截图已生成";
  if (tool === "replay_actions" && count(data.replayed) && count(data.total)) return `实际回放 ${data.replayed}/${data.total} 步`;
  if (tool === "stop_recording" && Array.isArray(data.actions)) return `返回 ${data.actions.length} 条操作记录`;
  for (const [key, label] of [["marked", "已标记元素"], ["cleared", "已清除标记"], ["clippedCount", "发现裁切元素"]]) if (count(data[key])) return `${label} ${data[key]} 个`;
  const states: Record<string, string> = { recording: "已开始录制", "already-recording": "录制已在进行", "not-recording": "当前没有录制", attached: "已开启网络采集", detached: "已停止网络采集", shown: "提示面板已显示", hidden: "提示面板已隐藏", updated: "提示文字已更新" };
  if (typeof data.status === "string" && states[data.status]) return states[data.status];
  if (data.success === true || data.ok === true) return "操作已完成";
  return "工具调用已返回";
}
