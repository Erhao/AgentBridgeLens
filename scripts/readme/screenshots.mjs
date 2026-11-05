// Build first: pnpm build
// ABL_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/readme/screenshots.mjs
// Uses an isolated Chromium profile, local demo content and scripted Bridge requests.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.ABL_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../packages/bridge/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const output = `${root}docs/images`;
await mkdir(output, { recursive: true });
const html = await readFile(new URL('./demo.html', import.meta.url));
const http = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }).listen(0, '127.0.0.1');
await once(http, 'listening');
const bridges = await Promise.all([0, 1].map(async () => {
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(ws, 'listening');
  const pending = new Map();
  let socket;
  ws.on('connection', client => {
    socket = client;
    client.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      pending.get(msg.id)?.(msg);
    });
  });
  return { ws, ready: () => !!socket, call(tool, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${tool}`)); }, 20000);
      pending.set(id, msg => { clearTimeout(timeout); pending.delete(id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
      socket.send(JSON.stringify({ id, tool, params }));
    });
  } };
}));
let context;
try {
  const extension = `${root}packages/extension/dist`;
  context = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1,
    ...(process.env.ABL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ABL_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // Authorize only the disposable demo profile. Never touches a user's profile.
  await worker.evaluate(profiles => chrome.storage.local.set({ bridgeConsent: true, bridgeProfiles: profiles, activityToastSeconds: 30 }), bridges.map((b, i) => ({ id: `demo-${i}`, name: ['本地开发 / Local', '协作服务 / Review'][i], host: '127.0.0.1', port: b.ws.address().port, token: '', enabled: true, color: ['#6366f1', '#14b8a6'][i] })));
  for (let i = 0; !bridges.every(b => b.ready()) && i < 100; i++) await new Promise(r => setTimeout(r, 100));
  if (!bridges.every(b => b.ready())) throw new Error('Demo bridges did not connect');
  const page = await context.newPage();
  const url = `http://127.0.0.1:${http.address().port}/checkout`;
  await page.goto(url);
  await page.locator('#bridgelens-activity-toast').waitFor({ state: 'detached' });
  const { tabs } = await bridges[0].call('list_tabs');
  const tabId = tabs.find(t => t.url === url).tabId;
  await bridges[0].call('set_target_tab', { tabId });
  await bridges[0].call('mark_elements', { tabId, selectors: ['#checkout'], label: 'Inspect this button', color: '#6366f1' });
  const shot = await bridges[0].call('capture_screenshot', { tabId });
  await writeFile(`${output}/page-inspection.png`, Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
  await bridges[0].call('clear_overlays', { tabId });
  await page.waitForTimeout(200);
  // Let earlier cards expire before capturing two independent calls.
  await worker.evaluate(() => chrome.storage.local.set({ activityToastSeconds: 5 }));
  await page.locator('#bridgelens-activity-toast').waitFor({ state: 'detached', timeout: 10000 });
  await bridges[0].call('inspect_element', { tabId, selector: '#checkout' });
  await bridges[1].call('get_performance_metrics', { tabId });
  await page.waitForFunction(() => document.querySelector('#bridgelens-activity-toast')?.shadowRoot.querySelectorAll('.card').length === 2);
  await page.screenshot({ path: `${output}/live-activity.png` });
  const controls = await context.newPage();
  await controls.setViewportSize({ width: 380, height: 1100 });
  await controls.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await controls.locator('.bl-bridge-line.ok').first().waitFor();
  await controls.locator('#bl-conn').evaluate(el => { el.open = true; });
  await controls.locator('#bl-target-mode').selectOption('pinned');
  await controls.locator('#bl-target-page').selectOption(String(tabId));
  await controls.screenshot({ path: `${output}/connection-controls.png`, fullPage: true });
  console.log('Saved 3 real extension screenshots to docs/images (isolated demo profile).');
} finally {
  await context?.close();
  for (const bridge of bridges) { for (const client of bridge.ws.clients) client.terminate(); await new Promise(r => bridge.ws.close(r)); }
  http.closeAllConnections();
  await new Promise(r => http.close(r));
}
