import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/**
 * 把一段 JS 错误堆栈，经 source map 还原到原始源码文件与行号。
 * 完全在 Bridge 端完成：解析堆栈帧 → 抓对应的 .js → 找 sourceMappingURL → 抓/解码 .map →
 * 用 trace-mapping 反查原始位置。
 *
 * 前提：bundle 与 source map 对 Bridge（本机）可访问（dev server 通常是 localhost，可直连）。
 */

interface Frame {
  url: string;
  line: number;
  column: number;
  raw: string;
}

function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  const re = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/;
  for (const line of stack.split("\n")) {
    const m = re.exec(line);
    if (m) {
      frames.push({
        url: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        raw: line.trim(),
      });
    }
  }
  return frames;
}

async function loadTraceMap(jsUrl: string): Promise<TraceMap | null> {
  const res = await fetch(jsUrl);
  if (!res.ok) return null;
  const js = await res.text();
  const m = /\/\/[#@]\s*sourceMappingURL=(.+?)\s*$/m.exec(js);
  if (!m) return null;

  const mapRef = m[1].trim();
  let rawMap: string;
  if (mapRef.startsWith("data:")) {
    const comma = mapRef.indexOf(",");
    const meta = mapRef.slice(0, comma);
    const payload = mapRef.slice(comma + 1);
    rawMap = meta.includes("base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } else {
    const abs = new URL(mapRef, jsUrl).href;
    const mr = await fetch(abs);
    if (!mr.ok) return null;
    rawMap = await mr.text();
  }
  return new TraceMap(JSON.parse(rawMap));
}

export async function traceErrorToSource(stack: string) {
  const frames = parseStack(stack);
  if (frames.length === 0) {
    return {
      error: "未从堆栈中解析出 url:line:column 形式的帧",
      hint: "请传入包含完整 URL 的堆栈（如 Chrome 控制台里 Error.stack 的内容）",
    };
  }

  const cache = new Map<string, TraceMap | null>();
  const resolved = [];
  for (const f of frames) {
    if (!cache.has(f.url)) {
      try {
        cache.set(f.url, await loadTraceMap(f.url));
      } catch {
        cache.set(f.url, null);
      }
    }
    const map = cache.get(f.url) ?? null;
    if (map) {
      const pos = originalPositionFor(map, { line: f.line, column: f.column });
      resolved.push({
        raw: f.raw,
        source: pos.source,
        line: pos.line,
        column: pos.column,
        name: pos.name,
      });
    } else {
      resolved.push({
        raw: f.raw,
        note: "无 source map（生产构建未发布 .map，或文件不可访问）",
        url: f.url,
        line: f.line,
        column: f.column,
      });
    }
  }
  return { frames: resolved };
}
