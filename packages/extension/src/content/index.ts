import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { getPageInfo, getDomSnapshot, inspectElement, executeJs, getElementRect } from "./dom-inspector";
import { highlightElement, clearHighlights } from "./highlighter";
import { startCapture as startConsoleCapture, getConsoleLogs, getErrors } from "./console-capture";
import { startCapture as startNetworkCapture, getNetworkRequests } from "./network-capture";
import { startPerfCapture, getPerformanceMetrics } from "./performance";
import { getAccessibilityTree } from "./accessibility";
import { markElements, visualizeLayout, showResponsiveFrame, clearOverlays } from "./overlays";
import { startRecording, stopRecording, replayActions, type RecordedAction } from "./recorder";
import { showHud, hideHud, updateHud } from "./hud";

startConsoleCapture();
startNetworkCapture();
startPerfCapture();

const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
  get_page_info: () => getPageInfo(),
  get_dom_snapshot: (p) => getDomSnapshot(p.selector as string | undefined, p.maxDepth as number | undefined),
  inspect_element: (p) => inspectElement(p.selector as string),
  get_element_rect: (p) => getElementRect(p.selector as string),
  execute_js: (p) => executeJs(p.code as string),
  highlight_element: (p) =>
    highlightElement(p.selector as string, p.color as string | undefined, p.label as string | undefined),
  clear_highlights: () => clearHighlights(),
  get_console_logs: (p) => getConsoleLogs(p.level as string | undefined, p.limit as number | undefined),
  get_errors: () => getErrors(),
  get_network_requests: (p) =>
    getNetworkRequests(p.urlPattern as string | undefined, p.status as number | undefined),
  get_performance_metrics: () => getPerformanceMetrics(),
  get_accessibility_tree: (p) =>
    getAccessibilityTree(p.selector as string | undefined, p.maxDepth as number | undefined),
  mark_elements: (p) =>
    markElements(p.selectors as string[], p.color as string | undefined, p.label as string | undefined),
  visualize_layout: () => visualizeLayout(),
  show_responsive_frame: (p) => showResponsiveFrame(p.width as number | undefined),
  clear_overlays: () => clearOverlays(),
  start_recording: () => startRecording(),
  stop_recording: () => stopRecording(),
  replay_actions: (p) => replayActions(p.actions as RecordedAction[]),
  show_hud: () => showHud(),
  hide_hud: () => hideHud(),
  update_hud: (p) => updateHud(p.text as string),
};

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, _sender, _sendResponse) => {
    if (message.type !== "bridgelens-request") return;

    const handler = handlers[message.tool];
    const response: ContentResponse = { type: "bridgelens-response", id: message.id };

    void (async () => {
      if (!handler) {
        response.error = { message: `Unknown tool: ${message.tool}` };
      } else {
        try {
          response.result = await handler(message.params);
        } catch (err) {
          response.error = { message: err instanceof Error ? err.message : String(err) };
        }
      }
      chrome.runtime.sendMessage(response);
    })();
  }
);

console.log("[BridgeLens] Content script loaded");
