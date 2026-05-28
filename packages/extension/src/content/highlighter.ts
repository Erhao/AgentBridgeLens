const OVERLAY_CLASS = "bridgelens-highlight";
const LABEL_CLASS = "bridgelens-label";

function injectStyles() {
  if (document.getElementById("bridgelens-styles")) return;
  const style = document.createElement("style");
  style.id = "bridgelens-styles";
  style.textContent = `
    .${OVERLAY_CLASS} {
      position: absolute;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px solid var(--bl-color, #ff6b6b);
      background: color-mix(in srgb, var(--bl-color, #ff6b6b) 10%, transparent);
      transition: all 0.2s ease;
    }
    .${LABEL_CLASS} {
      position: absolute;
      top: -22px;
      left: -2px;
      background: var(--bl-color, #ff6b6b);
      color: #fff;
      font: 11px/1 monospace;
      padding: 3px 6px;
      border-radius: 3px 3px 0 0;
      white-space: nowrap;
      z-index: 2147483647;
    }
  `;
  document.head.appendChild(style);
}

export function highlightElement(
  selector: string,
  color = "#ff6b6b",
  label?: string
): { success: boolean; error?: string } {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };

  injectStyles();

  const rect = el.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;
  overlay.style.setProperty("--bl-color", color);
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  if (label) {
    const labelEl = document.createElement("div");
    labelEl.className = LABEL_CLASS;
    labelEl.textContent = label;
    overlay.appendChild(labelEl);
  }

  document.body.appendChild(overlay);
  return { success: true };
}

export function clearHighlights(): { cleared: number } {
  const overlays = document.querySelectorAll(`.${OVERLAY_CLASS}`);
  overlays.forEach((el) => el.remove());
  return { cleared: overlays.length };
}
