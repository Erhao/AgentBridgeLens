/**
 * 实时跟踪元素的叠加框：用 requestAnimationFrame 每帧按元素当前 getBoundingClientRect
 * 重新定位，因此滚动 / reflow / 动画时红框都紧贴元素（类似 DevTools 的高亮）。
 * 框挂在一个 position:fixed 的层里，框本身用 transform 定位到元素的视口坐标。
 */

type Group = "highlight" | "overlay";

interface Tracked {
  el: Element;
  box: HTMLElement;
  group: Group;
}

const LAYER_ID = "bridgelens-overlay-layer";
let layer: HTMLElement | null = null;
let tracked: Tracked[] = [];
let rafId: number | null = null;

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  document.documentElement.appendChild(layer);
  return layer;
}

function reposition() {
  for (const t of tracked) {
    const visible = t.el.isConnected;
    const r = visible ? t.el.getBoundingClientRect() : null;
    if (!r || (r.width === 0 && r.height === 0)) {
      t.box.style.display = "none";
      continue;
    }
    t.box.style.display = "block";
    t.box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    t.box.style.width = `${r.width}px`;
    t.box.style.height = `${r.height}px`;
  }
  rafId = tracked.length ? requestAnimationFrame(reposition) : null;
}

function startLoop() {
  if (rafId === null && tracked.length) rafId = requestAnimationFrame(reposition);
}

export function trackBox(
  el: Element,
  opts: { color?: string; label?: string; dashed?: boolean },
  group: Group
): void {
  const lyr = ensureLayer();
  const color = opts.color || "#ff3b30";
  const box = document.createElement("div");
  box.style.cssText =
    `position:absolute;top:0;left:0;box-sizing:border-box;pointer-events:none;` +
    `border:2px ${opts.dashed ? "dashed" : "solid"} ${color};` +
    `background:color-mix(in srgb, ${color} 12%, transparent);will-change:transform,width,height;`;
  if (opts.label) {
    const l = document.createElement("div");
    l.textContent = opts.label;
    l.style.cssText =
      `position:absolute;left:-2px;top:-18px;background:${color};color:#fff;` +
      `font:11px/1.4 monospace;padding:0 4px;white-space:nowrap;border-radius:3px 3px 0 0;`;
    box.appendChild(l);
  }
  lyr.appendChild(box);
  tracked.push({ el, box, group });
  startLoop();
}

/** 清除叠加框；不传 group 清全部，传则只清该组。返回清除数量。 */
export function clearTracked(group?: Group): number {
  const keep: Tracked[] = [];
  let cleared = 0;
  for (const t of tracked) {
    if (group === undefined || t.group === group) {
      t.box.remove();
      cleared++;
    } else {
      keep.push(t);
    }
  }
  tracked = keep;
  if (tracked.length === 0) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // 层可能还挂着响应式参考框等非跟踪元素，只有空了才移除
    if (layer && layer.childElementCount === 0) {
      layer.remove();
      layer = null;
    }
  }
  return cleared;
}

/** 供响应式参考框等"非跟踪、固定在视口"的元素挂载用。 */
export function overlayLayer(): HTMLElement {
  return ensureLayer();
}
