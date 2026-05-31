import { describe } from "./selector";
import { trackBox, clearTracked, overlayLayer } from "./overlay-tracker";

const RESP_FRAME_ID = "bridgelens-responsive-frame";

export function clearOverlays() {
  clearTracked("overlay");
  document.getElementById(RESP_FRAME_ID)?.remove();
  return { ok: true };
}

/** 标注一组元素（差异标注：红框圈出 agent 改动过的元素），实时跟随滚动。 */
export function markElements(selectors: string[], color = "#ff3b30", label?: string) {
  let marked = 0;
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        trackBox(el, { color, label }, "overlay");
        marked++;
      });
    } catch {
      /* invalid selector */
    }
  }
  return { marked };
}

/** 布局可视化：圈出内容被 overflow 截断的元素（橙色虚线，实时跟随）。 */
export function visualizeLayout() {
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
        trackBox(el, { color: "#ff9500", label: "clipped", dashed: true }, "overlay");
        clipped.push(describe(el));
      }
    }
  });
  return { clippedCount: clipped.length, clipped: clipped.slice(0, 50) };
}

/**
 * 响应式参考框：在当前页叠加一个目标视口宽度的框，并列出比它更宽（可能溢出）的元素。
 * 这个框是"视口参考线"，本就该固定在视口、不随滚动移动（与跟踪框不同）。
 */
export function showResponsiveFrame(width = 375) {
  document.getElementById(RESP_FRAME_ID)?.remove();
  const layer = overlayLayer();
  const frameLeft = Math.max(0, (window.innerWidth - width) / 2);
  const frame = document.createElement("div");
  frame.id = RESP_FRAME_ID;
  frame.style.cssText =
    `position:fixed;left:${frameLeft}px;top:0;width:${width}px;height:100vh;` +
    `border:2px solid #007aff;box-sizing:border-box;background:rgba(0,122,255,.04);pointer-events:none;`;
  const tag = document.createElement("div");
  tag.textContent = `${width}px`;
  tag.style.cssText =
    "position:absolute;left:0;top:0;background:#007aff;color:#fff;font:11px/1.4 monospace;padding:0 4px;";
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
    note: "蓝框为目标视口宽度参考（固定在视口）；examples 列出比它更宽、可能在小屏溢出的元素。",
  };
}
