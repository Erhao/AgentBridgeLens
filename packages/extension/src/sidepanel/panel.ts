import { mountControls } from "../shared/panel-ui";

// 连接配置 + 目标标签页控件，与点击扩展图标弹出的 popup 完全一致。
mountControls(document.getElementById("controls")!);

// —— side panel 特有：交互式确认 ——
const confirmEl = document.getElementById("confirm") as HTMLDivElement;
const confirmMsg = document.getElementById("confirm-msg") as HTMLParagraphElement;
const confirmOptions = document.getElementById("confirm-options") as HTMLDivElement;

interface Confirmation {
  cid: string;
  message: string;
  options: string[];
  bridgeName: string;
  bridgeUrl: string;
}
const confirmations: Confirmation[] = [];
function renderConfirm() {
  const current = confirmations[0];
  confirmEl.style.display = current ? "block" : "none";
  if (!current) return;
  confirmMsg.textContent = `${current.bridgeName} (${current.bridgeUrl})：${current.message}`;
  confirmOptions.innerHTML = "";
  for (const opt of current.options) {
    const btn = document.createElement("button");
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "bridgelens-confirm-result", cid: current.cid, choice: opt });
      confirmations.shift();
      renderConfirm();
    });
    confirmOptions.appendChild(btn);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridgelens-confirm") {
    confirmations.push(message);
    renderConfirm();
  } else if (message?.type === "bridgelens-confirm-dismiss") {
    const index = confirmations.findIndex((item) => item.cid === message.cid);
    if (index !== -1) confirmations.splice(index, 1);
    renderConfirm();
  }
});
