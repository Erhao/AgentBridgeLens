// Build bridge and extension first. Uses an isolated browser profile and local test servers.
// ABL_PLAYWRIGHT_MODULE can point to a separately installed Playwright.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || 'playwright');
const require = createRequire(new URL('../../bridge/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIDGELENS_')));
const child = spawn(process.execPath, [fileURLToPath(new URL('../../bridge/dist/index.js', import.meta.url))], {
  env: { ...env, BRIDGELENS_PORT: String(port), BRIDGELENS_TOKEN: 'browser-test-secret' },
  stdio: ['pipe', 'ignore', 'pipe'],
});
const old = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: () => false });
await once(old, 'listening');
let context;
try {
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => { if (String(chunk).includes('WebSocket server listening')) resolve(); });
    child.once('exit', (code) => reject(new Error(`Bridge exited: ${code}`)));
  });
  const extension = fileURLToPath(new URL('../dist', import.meta.url));
  context = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(([port, oldPort]) => chrome.storage.local.set({ bridgeConsent: true,
    bridgeProfiles: [
      { id: 'n100', name: 'N100-tailnet', host: '127.0.0.1', port, token: 'wrong', enabled: true, color: '#c084fc' },
      { id: 'old', name: '旧版 Bridge', host: '127.0.0.1', port: oldPort, token: '', enabled: true, color: '#fb923c' },
    ], activityDisplayEnabled: false,
  }), [port, old.address().port]);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await page.waitForLoadState('networkidle');
  await page.getByText(/HTTP 401：鉴权失败/).waitFor({ timeout: 10000 });
  await page.getByText(/旧版.*无法确认鉴权/).waitFor({ timeout: 10000 });
  const status = () => page.evaluate(() => chrome.runtime.sendMessage({ type: 'bridgelens-get-status' }));
  const initial = (await status()).bridges[0];
  assert.equal(initial.state, 'retrying');
  assert.match(initial.lastError, /401/);
  assert.ok(!(await page.locator('#bl-services').innerText()).includes('browser-test-secret'));
  await page.waitForFunction(() => document.querySelector('#bl-services').textContent.includes('已尝试'));
  const n100 = page.locator('.bl-bridge-line').filter({ hasText: 'N100-tailnet' });
  assert.equal(await n100.getByRole('button', { name: '立即重连 N100-tailnet', exact: true }).count(), 1);
  const before = (await status()).bridges[0].attempts;
  await n100.getByRole('button', { name: '立即重连 N100-tailnet', exact: true }).click();
  assert.ok((await status()).bridges[0].attempts > before);
  await page.waitForTimeout(3200);
  assert.ok((await status()).bridges[0].attempts > before + 1, 'automatic retry continues');
  // A suspended worker must resume its existing backoff, rather than reconnect immediately.
  const checkpoint = (await status()).bridges.find((bridge) => bridge.id === 'n100');
  const persisted = await page.evaluate(() => chrome.storage.session.get('connectionRetryState'));
  assert.equal(persisted.connectionRetryState.n100.nextRetryAt, checkpoint.nextRetryAt);
  assert.ok(!JSON.stringify(persisted).includes('wrong'), 'session retry data contains no credentials');
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  await page.waitForTimeout(100);
  const version = [...versions.values()].find((item) => item.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(version, 'extension worker is visible to CDP');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'bridgelens-get-status' })).bridges.some((bridge) => bridge.id === 'n100'));
  const resumed = (await status()).bridges.find((bridge) => bridge.id === 'n100');
  assert.equal(resumed.attempts, checkpoint.attempts);
  assert.equal(resumed.nextRetryAt, checkpoint.nextRetryAt);
  await cdp.detach();
  await mkdir('/tmp/abl-connection-qa', { recursive: true });
  await writeFile('/tmp/abl-connection-qa/status.html', (await page.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: `/tmp/abl-connection-qa/failed-${width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  // Correct credentials in the real settings editor, then recover without reloading the extension.
  const service = page.locator('[data-service-id="n100"]');
  await service.locator('.el-collapse-item__header').click();
  await service.locator('input[name="token"]').fill('browser-test-secret');
  await service.locator('.bl-service-save').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.bl-bridge-line.ok')].some((row) => row.textContent.includes('N100-tailnet')));
  const recovered = (await status()).bridges.find((bridge) => bridge.id === 'n100');
  assert.equal(recovered.connected, true);
  assert.equal(recovered.lastError, undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/abl-connection-qa/recovered.png', fullPage: true });
  // Revoking consent cancels all connections and manual retry cannot re-enable them.
  await page.evaluate(() => chrome.storage.local.set({ bridgeConsent: false }));
  await page.locator('#bl-status').getByText(/连接已暂停/).waitFor();
  assert.deepEqual((await status()).bridges, []);
  assert.equal(await page.getByRole('button', { name: /立即重连/ }).count(), 0);
  console.log('PASS: HTTP 401, legacy fallback, retry progress, manual retry, worker backoff recovery, credential recovery, consent and responsive layout');
} finally {
  await context?.close();
  child.kill('SIGKILL');
  for (const client of old.clients) client.terminate();
  old.close();
}
