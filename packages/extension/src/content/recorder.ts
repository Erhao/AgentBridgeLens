import { cssSelector } from "./selector";

export interface RecordedAction {
  type: "click" | "input" | "change" | "scroll";
  selector?: string;
  value?: string;
  x?: number;
  y?: number;
  timestamp: number;
}

let recording = false;
let actions: RecordedAction[] = [];
let startTime = 0;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;

function rel(): number {
  return Math.round(performance.now() - startTime);
}

const onClick = (e: MouseEvent) => {
  const t = e.target as Element;
  if (t && t.nodeType === 1) {
    actions.push({ type: "click", selector: cssSelector(t), timestamp: rel() });
  }
};
const onInput = (e: Event) => {
  const t = e.target as HTMLInputElement;
  if (t && t.nodeType === 1) {
    actions.push({ type: "input", selector: cssSelector(t), value: t.value, timestamp: rel() });
  }
};
const onChange = (e: Event) => {
  const t = e.target as HTMLInputElement;
  if (t && t.nodeType === 1) {
    actions.push({ type: "change", selector: cssSelector(t), value: t.value, timestamp: rel() });
  }
};
const onScroll = () => {
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    actions.push({ type: "scroll", x: window.scrollX, y: window.scrollY, timestamp: rel() });
  }, 150);
};

export function startRecording() {
  if (recording) return { status: "already-recording" };
  recording = true;
  actions = [];
  startTime = performance.now();
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  window.addEventListener("scroll", onScroll, true);
  return { status: "recording" };
}

export function stopRecording() {
  if (!recording) return { status: "not-recording", actions: [] };
  recording = false;
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("change", onChange, true);
  window.removeEventListener("scroll", onScroll, true);
  return { status: "stopped", count: actions.length, actions };
}

export async function replayActions(input: RecordedAction[]) {
  const list = Array.isArray(input) ? input : [];
  let replayed = 0;
  for (const a of list) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if (a.type === "scroll") {
        window.scrollTo(a.x || 0, a.y || 0);
        replayed++;
        continue;
      }
      if (!a.selector) continue;
      const el = document.querySelector(a.selector) as HTMLElement | null;
      if (!el) continue;
      if (a.type === "click") {
        el.click();
        replayed++;
      } else if (a.type === "input" || a.type === "change") {
        const field = el as HTMLInputElement;
        field.value = a.value ?? "";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        replayed++;
      }
    } catch {
      /* skip failed step */
    }
  }
  return { replayed, total: list.length };
}
