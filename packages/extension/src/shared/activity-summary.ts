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
    const structured = object(value), fields: string[] = [];
    for (const [key, label] of [["rowCount", "行数"], ["count", "数量"], ["total", "总数"], ["matchedCount", "匹配数"], ["elementCount", "元素数"], ["requestCount", "请求数"], ["errorCount", "错误数"], ["visibleCount", "可见数"]]) {
      if (count(structured[key])) fields.push(`${label} ${structured[key]}`);
    }
    if (count(structured.status) && structured.status >= 100 && structured.status <= 599) fields.push(`HTTP ${structured.status}`);
    if (fields.length) return `脚本返回：${fields.slice(0, 4).join("；")}`;
    return "脚本执行完成，未提供结果说明";
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
