import { mountControls } from "../shared/panel-ui";

// 连接配置 + 目标标签页控件，与点击扩展图标弹出的 popup 完全一致。
mountControls(document.getElementById("controls")!);

// —— side panel 特有：Agent 活动日志 + 交互式确认 ——
const logEl = document.getElementById("log") as HTMLUListElement;
const confirmEl = document.getElementById("confirm") as HTMLDivElement;
const confirmMsg = document.getElementById("confirm-msg") as HTMLParagraphElement;
const confirmOptions = document.getElementById("confirm-options") as HTMLDivElement;

let logCount = 0;

function appendLog(tool: string, ts: number) {
  if (logCount === 0) logEl.innerHTML = "";
  logCount++;
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = tool;
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = new Date(ts).toLocaleTimeString();
  li.appendChild(name);
  li.appendChild(time);
  logEl.insertBefore(li, logEl.firstChild);
  while (logEl.children.length > 100) logEl.removeChild(logEl.lastChild!);
}

function showConfirm(cid: string, message: string, options: string[]) {
  confirmMsg.textContent = message;
  confirmOptions.innerHTML = "";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "bridgelens-confirm-result", cid, choice: opt });
      confirmEl.style.display = "none";
    });
    confirmOptions.appendChild(btn);
  }
  confirmEl.style.display = "block";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridgelens-activity") {
    appendLog(message.tool, message.ts);
  } else if (message?.type === "bridgelens-confirm") {
    showConfirm(message.cid, message.message, message.options);
  }
});
