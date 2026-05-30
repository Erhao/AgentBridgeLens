/**
 * 这些函数通过 chrome.scripting.executeScript({ world: "MAIN" }) 注入页面主世界执行，
 * 因此必须是**自包含**的：不能引用模块作用域里的任何外部标识符（会在页面里运行）。
 * React fiber 的 `_debugSource` 等内部属性挂在页面主世界的 DOM 节点上，
 * content script 的隔离世界访问不到，所以源码定位只能在主世界做。
 */

/** 从 DOM 元素回溯到组件源码文件与行号（React 开发构建 / Vue 开发构建）。 */
export function traceElementToSource(selector: string) {
  const el = document.querySelector(selector);
  if (!el) return { error: `Element not found: ${selector}` };

  const typeName = (t: unknown): string | undefined => {
    if (typeof t === "function") {
      const fn = t as { displayName?: string; name?: string };
      return fn.displayName || fn.name;
    }
    if (typeof t === "string") return t;
    return undefined;
  };

  // React：找挂在 DOM 节点上的 fiber，沿 .return 向上找带 _debugSource 的节点
  const reactKey = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  if (reactKey) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber: any = (el as any)[reactKey];
    while (fiber) {
      const src = fiber._debugSource;
      if (src && src.fileName) {
        return {
          framework: "react",
          fileName: src.fileName,
          lineNumber: src.lineNumber,
          columnNumber: src.columnNumber,
          component: typeName(fiber.type) || typeName(fiber._debugOwner?.type),
        };
      }
      fiber = fiber.return;
    }
    return {
      framework: "react",
      note: "检测到 React，但 fiber 链上没有 _debugSource。源码位置仅在开发构建（启用 @babel/plugin-transform-react-jsx-source，CRA/Next/Vite dev 默认开启）下可用。",
    };
  }

  // Vue 3：__vueParentComponent，沿 parent 向上找 type.__file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v3: any = (el as any).__vueParentComponent;
  if (v3) {
    let inst = v3;
    while (inst) {
      const file = inst.type?.__file;
      if (file) {
        return { framework: "vue", fileName: file, component: inst.type?.__name || inst.type?.name };
      }
      inst = inst.parent;
    }
    return { framework: "vue", note: "检测到 Vue 3，但组件无 __file（仅开发构建可用）。" };
  }

  // Vue 2：__vue__.$options.__file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v2: any = (el as any).__vue__;
  if (v2) {
    const file = v2.$options?.__file;
    return file
      ? { framework: "vue", fileName: file, component: v2.$options?.name }
      : { framework: "vue", note: "检测到 Vue 2，但组件无 __file。" };
  }

  return {
    note: "该元素上未发现 React/Vue 实例。源码定位目前支持 React 和 Vue 的开发构建。",
  };
}

/** 从元素匹配到的 CSS 规则，回溯到样式表来源（文件 href + 规则文本）。 */
export function traceStyleToSource(selector: string, property?: string) {
  const el = document.querySelector(selector);
  if (!el) return { error: `Element not found: ${selector}` };

  const matched: Array<{
    href: string;
    selectorText?: string;
    cssText?: string;
    value?: string;
    note?: string;
  }> = [];

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      matched.push({ href: sheet.href || "(unknown)", note: "跨域样式表，规则不可读" });
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      let isMatch = false;
      try {
        isMatch = el.matches(rule.selectorText);
      } catch {
        continue;
      }
      if (!isMatch) continue;
      if (property && !rule.style.getPropertyValue(property)) continue;
      matched.push({
        href: sheet.href || "(内联 <style>)",
        selectorText: rule.selectorText,
        cssText: rule.cssText,
        value: property ? rule.style.getPropertyValue(property) : undefined,
      });
    }
  }

  return {
    selector,
    property,
    matchedRules: matched,
    note:
      matched.length === 0
        ? "未找到匹配的 CSS 规则（或样式表均为跨域不可读）。"
        : "CSSOM 不提供行号；如需源文件原始行号需 CSS source map（待实现）。",
  };
}
