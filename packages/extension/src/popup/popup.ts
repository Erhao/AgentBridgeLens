import { getBridgeConfig, setBridgeConfig, DEFAULT_HOST, DEFAULT_PORT } from "../shared/config";

const hostInput = document.getElementById("host") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

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

async function load() {
  const { host, port, token } = await getBridgeConfig();
  hostInput.value = host;
  portInput.value = String(port);
  tokenInput.value = token;
  refreshStatus();
}

saveBtn.addEventListener("click", async () => {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  const token = tokenInput.value.trim();
  await setBridgeConfig({ host, port, token });
  statusEl.textContent = "已保存，重连中…";
  statusEl.className = "status";
  setTimeout(refreshStatus, 600);
});

load();
setInterval(refreshStatus, 2000);
