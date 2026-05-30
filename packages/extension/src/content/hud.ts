const HUD_ID = "bridgelens-hud";

export function showHud() {
  if (document.getElementById(HUD_ID)) return { status: "already-shown" };
  const hud = document.createElement("div");
  hud.id = HUD_ID;
  hud.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
    "background:rgba(20,24,30,.92);color:#e6edf3;font:12px/1.5 system-ui,sans-serif;" +
    "padding:8px 10px;border-radius:8px;max-width:260px;box-shadow:0 4px 14px rgba(0,0,0,.35);";
  hud.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px;">AgentBridgeLens</div>` +
    `<div id="${HUD_ID}-status" style="opacity:.85;">就绪</div>`;
  document.documentElement.appendChild(hud);
  return { status: "shown" };
}

export function hideHud() {
  document.getElementById(HUD_ID)?.remove();
  return { status: "hidden" };
}

export function updateHud(text: string) {
  const status = document.getElementById(`${HUD_ID}-status`);
  if (!status) return { status: "hud-not-shown" };
  status.textContent = text;
  return { status: "updated" };
}
