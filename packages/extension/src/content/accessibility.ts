/**
 * 基于 DOM + ARIA 属性构建一棵简化的可访问性树。
 * 注：这是近似实现（隐式 role 表 + 简化的可访问名计算），不如 CDP 的
 * Accessibility.getFullAXTree 精确，但无需附加 debugger，足够 agent 理解页面语义结构。
 */

const IMPLICIT_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  input: "textbox",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  ul: "list",
  ol: "list",
  li: "listitem",
  form: "form",
  table: "table",
  select: "combobox",
  textarea: "textbox",
  section: "region",
  article: "article",
  aside: "complementary",
};

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit") return "button";
    if (type === "search") return "searchbox";
  }
  return IMPLICIT_ROLE[tag] || "";
}

function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const names = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (names.length) return names.join(" ");
  }

  const alt = el.getAttribute("alt");
  if (alt) return alt.trim();

  const title = el.getAttribute("title");
  if (title) return title.trim();

  // 对叶子交互元素，取直接文本
  const tag = el.tagName.toLowerCase();
  if (["button", "a", "h1", "h2", "h3", "h4", "h5", "h6", "label", "li"].includes(tag)) {
    const text = el.textContent?.trim() || "";
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }
  return "";
}

interface AxNode {
  role: string;
  name?: string;
  tag: string;
  children?: AxNode[];
}

function build(el: Element, depth: number, maxDepth: number): AxNode | null {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  if (el.getAttribute("aria-hidden") === "true") return null;

  const role = roleOf(el);
  const name = accessibleName(el);

  const children: AxNode[] = [];
  if (depth < maxDepth) {
    for (const child of Array.from(el.children)) {
      const node = build(child, depth + 1, maxDepth);
      if (node) children.push(node);
    }
  }

  // 无 role 也无名、且只有一个/没有可见子节点时，提升子节点（减少噪音）
  if (!role && !name) {
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
  }

  const node: AxNode = { role: role || "generic", tag: el.tagName.toLowerCase() };
  if (name) node.name = name;
  if (children.length) node.children = children;
  return node;
}

export function getAccessibilityTree(selector?: string, maxDepth = 12) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `Element not found: ${selector}` };
  return build(root, 0, maxDepth) || { note: "Root node is not visible." };
}
