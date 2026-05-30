/** 为元素生成一个尽量稳定、可复用的 CSS 选择器。 */
export function cssSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    if (node.classList.length) {
      part +=
        "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName
      );
      if (sameTag.length > 1) {
        part += `:nth-child(${Array.from(parent.children).indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

/** 元素的简短描述（用于日志/报告）。 */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
  return `${tag}${id}${cls}`;
}
