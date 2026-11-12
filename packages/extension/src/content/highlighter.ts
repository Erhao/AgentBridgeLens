import { trackBox, clearTracked } from "./overlay-tracker";

export function highlightElement(
  selector: string,
  color = "#ff6b6b",
  label?: string,
  scrollIntoView = true
): { success: boolean; error?: string } {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  if (scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  trackBox(el, { color, label }, "highlight");
  return { success: true };
}

export function clearHighlights(): { cleared: number } {
  return { cleared: clearTracked("highlight") };
}
