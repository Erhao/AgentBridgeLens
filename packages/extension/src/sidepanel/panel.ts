const statusEl = document.getElementById("status") as HTMLDivElement;
const logEl = document.getElementById("log") as HTMLUListElement;
const confirmEl = document.getElementById("confirm") as HTMLDivElement;
const confirmMsg = document.getElementById("confirm-msg") as HTMLParagraphElement;
const confirmOptions = document.getElementById("confirm-options") as HTMLDivElement;

let logCount = 0;

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "bridgelens-get-status" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = "状态未知";
      statusEl.className = "status";
      return;
    }
    if (res.connected) {
      statusEl.textContent = `已连接 ${res.url}`;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent = "未连接（确认 Bridge Server 已启动）";
      statusEl.className = "status bad";
    }
  });
}

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

refreshStatus();
setInterval(refreshStatus, 2000);
