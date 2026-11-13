import { createApp } from "vue";
import PanelControls from "./PanelControls.vue";

/** The popup and side panel share the same Element Plus controls and settings. */
export function mountControls(root: HTMLElement): void {
  createApp(PanelControls).mount(root);
}
