let lcp = 0;
let cls = 0;

export function startPerfCapture() {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    /* not supported */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const shift = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* not supported */
  }
}

export function getPerformanceMetrics() {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const fcp = performance
    .getEntriesByType("paint")
    .find((p) => p.name === "first-contentful-paint")?.startTime;
  const mem = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  }).memory;

  return {
    navigation: nav
      ? {
          domInteractiveMs: Math.round(nav.domInteractive),
          domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
          loadMs: Math.round(nav.loadEventEnd),
          responseMs: Math.round(nav.responseEnd - nav.requestStart),
          transferSize: nav.transferSize,
        }
      : undefined,
    firstContentfulPaintMs: fcp !== undefined ? Math.round(fcp) : undefined,
    largestContentfulPaintMs: lcp ? Math.round(lcp) : undefined,
    cumulativeLayoutShift: Number(cls.toFixed(4)),
    memory: mem
      ? {
          usedJSHeapMB: Math.round(mem.usedJSHeapSize / 1048576),
          totalJSHeapMB: Math.round(mem.totalJSHeapSize / 1048576),
        }
      : undefined,
    resourceCount: performance.getEntriesByType("resource").length,
  };
}
