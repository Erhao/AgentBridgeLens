import { describe } from "./selector";

const LAYER_ID = "bridgelens-overlay-layer";

function ensureLayer(): HTMLElement {
  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    layer.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    document.documentElement.appendChild(layer);
  }
  return layer;
}

function box(rect: DOMRect, color: string, label?: string, dashed = false) {
  const layer = ensureLayer();
  const b = document.createElement("div");
  b.style.cssText =
    `position:absolute;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;` +
    `border:2px ${dashed ? "dashed" : "solid"} ${color};box-sizing:border-box;`;
  if (label) {
    const l = document.createElement("div");
    l.textContent = label;
    l.style.cssText =
      `position:absolute;left:0;top:-18px;background:${color};color:#fff;` +
      `font:11px/1.4 monospace;padding:0 4px;white-space:nowrap;`;
    b.appendChild(l);
  }
  layer.appendChild(b);
}

export function clearOverlays() {
  document.getElementById(LAYER_ID)?.remove();
  return { ok: true };
}

/** 标注一组元素（差异标注：agent 把改动过的 selector 传进来，用红框圈出）。 */
export function markElements(selectors: string[], color = "#ff3b30", label?: string) {
  ensureLayer();
  let marked = 0;
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        box(el.getBoundingClientRect(), color, label, false);
        marked++;
      });
    } catch {
      /* invalid selector */
    }
  }
  return { marked };
}

/** 布局可视化：圈出内容被 overflow 截断的元素。 */
export function visualizeLayout() {
  ensureLayer();
  const clipped: string[] = [];
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    const style = getComputedStyle(el);
    const hidden =
      style.overflow === "hidden" ||
      style.overflowX === "hidden" ||
      style.overflowY === "hidden";
    if (!hidden) return;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        box(rect, "#ff9500", "clipped", true);
        clipped.push(describe(el));
      }
    }
  });
  return { clippedCount: clipped.length, clipped: clipped.slice(0, 50) };
}

/** 响应式参考框：在当前页叠加一个目标视口宽度的框，并列出比它更宽（可能溢出）的元素。 */
export function showResponsiveFrame(width = 375) {
  const layer = ensureLayer();
  const frameLeft = Math.max(0, (window.innerWidth - width) / 2);
  const frame = document.createElement("div");
  frame.style.cssText =
    `position:absolute;left:${frameLeft}px;top:0;width:${width}px;height:${window.innerHeight}px;` +
    `border:2px solid #007aff;box-sizing:border-box;background:rgba(0,122,255,.04);`;
  const tag = document.createElement("div");
  tag.textContent = `${width}px`;
  tag.style.cssText =
    "position:absolute;left:0;top:-18px;background:#007aff;color:#fff;font:11px/1.4 monospace;padding:0 4px;";
  frame.appendChild(tag);
  layer.appendChild(frame);

  const wide: string[] = [];
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width > width && rect.width > 0) wide.push(describe(el));
  });
  return {
    frameWidth: width,
    widerThanFrameCount: wide.length,
    examples: wide.slice(0, 30),
    note: "蓝框为目标视口宽度；examples 列出比它更宽、可能在小屏溢出的元素。",
  };
}
