export function getPageInfo() {
  return {
    url: location.href,
    title: document.title,
    meta: Object.fromEntries(
      Array.from(document.querySelectorAll("meta")).map((m) => [
        m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("charset") || "unknown",
        m.getAttribute("content") || m.getAttribute("charset") || "",
      ])
    ),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentHeight: document.documentElement.scrollHeight,
    },
  };
}

function serializeNode(node: Element, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return { tag: node.tagName.toLowerCase(), truncated: true };

  const attrs: Record<string, string> = {};
  for (const attr of node.attributes) {
    if (attr.name === "style" && attr.value.length > 200) {
      attrs[attr.name] = attr.value.slice(0, 200) + "...";
    } else {
      attrs[attr.name] = attr.value;
    }
  }

  const children: unknown[] = [];
  for (const child of node.children) {
    children.push(serializeNode(child, depth + 1, maxDepth));
  }

  const textContent = Array.from(node.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.trim())
    .filter(Boolean)
    .join(" ");

  const result: Record<string, unknown> = {
    tag: node.tagName.toLowerCase(),
  };

  if (Object.keys(attrs).length > 0) result.attrs = attrs;
  if (textContent) result.text = textContent.slice(0, 500);
  if (children.length > 0) result.children = children;

  return result;
}

export function getDomSnapshot(selector?: string, maxDepth = 6) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `Element not found: ${selector}` };
  return serializeNode(root as Element, 0, maxDepth);
}

export function inspectElement(selector: string) {
  const el = document.querySelector(selector);
  if (!el) return { error: `Element not found: ${selector}` };

  const computed = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: el.className || undefined,
    textContent: el.textContent?.trim().slice(0, 500),
    attributes: Object.fromEntries(
      Array.from((el as Element).attributes).map((a) => [a.name, a.value])
    ),
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    computedStyle: {
      display: computed.display,
      position: computed.position,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      fontSize: computed.fontSize,
      fontFamily: computed.fontFamily,
      margin: computed.margin,
      padding: computed.padding,
      border: computed.border,
      overflow: computed.overflow,
      visibility: computed.visibility,
      opacity: computed.opacity,
      zIndex: computed.zIndex,
    },
    isVisible:
      rect.width > 0 &&
      rect.height > 0 &&
      computed.visibility !== "hidden" &&
      computed.display !== "none",
  };
}

export function executeJs(code: string): unknown {
  try {
    const fn = new Function(`return (${code})`);
    const result = fn();
    return { value: typeof result === "object" ? JSON.parse(JSON.stringify(result)) : result };
  } catch {
    try {
      const fn = new Function(code);
      fn();
      return { value: undefined };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
