import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as tlsServer } from "node:https";
import { connect, createServer as socksServer } from "node:net";
import { once } from "node:events";
import { readFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chooseProxy, parseMacProxy, normalizeProxy, createNetworkFetch, parseArgs, update, validateExtension, main } from "./update-extension.mjs";
import { createZip } from "../release/updater-package.mjs";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  });
  return server.address().port;
}
const env = { ...process.env, NO_PROXY: "", no_proxy: "", CURL_CA_BUNDLE: "", SSL_CERT_FILE: "", SSL_CERT_DIR: "" };

test("proxy selection supports CLI, environment, saved settings and Finder system settings", async () => {
  const systemProxy = `HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\nHTTPEnable : 1\nHTTPProxy : wrong\nHTTPPort : 7890`;
  assert.equal(parseMacProxy(systemProxy), "http://127.0.0.1:7897/");
  assert.equal(parseMacProxy("SOCKSEnable : 1\nSOCKSProxy : ::1\nSOCKSPort : 1080"), "socks5h://[::1]:1080");
  assert.equal(parseMacProxy("ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://local/proxy.pac"), undefined);
  assert.equal((await chooseProxy({}, {}, { env: {}, platform: "darwin", systemProxy })).proxy, "http://127.0.0.1:7897/");
  assert.equal((await chooseProxy({}, { proxy: "7898" }, { env: {}, platform: "darwin", systemProxy })).proxy, "http://127.0.0.1:7898/");
  assert.equal((await chooseProxy({}, { proxy: "7898" }, { env: { HTTPS_PROXY: "7899" }, platform: "darwin", systemProxy })).proxy, "http://127.0.0.1:7899/");
  assert.equal((await chooseProxy({ proxy: "socks5h://localhost:1080" }, {}, { env: { HTTPS_PROXY: "7899" } })).proxy, "socks5h://localhost:1080");
  assert.equal((await chooseProxy({ noProxy: true }, { proxy: "7898" }, { env: { HTTPS_PROXY: "7899" } })).proxy, "");
  assert.equal((await chooseProxy({}, {}, { env: { ALL_PROXY: "socks5h://localhost:1080" } })).proxy, "socks5h://localhost:1080");
  assert.equal(normalizeProxy("127.0.0.1:7897"), "http://127.0.0.1:7897/");
  assert.equal(parseArgs(["--proxy", "7897"]).proxy, "http://127.0.0.1:7897/");
  for (const input of ["file:///etc/passwd", "http://localhost/path", "http://localhost:99999", "http://user:%ZZ@localhost:7897", "http://localhost\n:7897"]) assert.throws(() => normalizeProxy(input));
  assert.throws(() => parseArgs(["--proxy", "7897", "--no-proxy"]));
  assert.throws(() => parseArgs(["--proxy"]));
});

test("HTTP proxy handles redirects without resolving destination hosts directly", async (t) => {
  const requests = [];
  const proxy = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "http://unresolvable.invalid/start") {
      res.writeHead(302, { Location: "http://another.invalid/result" }); res.end();
    } else { res.end("proxied download"); }
  });
  const port = await listen(t, proxy);
  const fetchImpl = createNetworkFetch(`http://127.0.0.1:${port}`, { env, retries: 0 });
  assert.equal(await (await fetchImpl("http://unresolvable.invalid/start")).text(), "proxied download");
  assert.deepEqual(requests, ["http://unresolvable.invalid/start", "http://another.invalid/result"]);
});

test("explicit direct mode bypasses inherited proxy variables", async (t) => {
  const port = await listen(t, createServer((_req, res) => res.end("direct")));
  const fetchImpl = createNetworkFetch("", { env: { ...env, http_proxy: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" }, retries: 0 });
  assert.equal(await (await fetchImpl(`http://127.0.0.1:${port}/`)).text(), "direct");
});

test("HTTPS CONNECT proxies metadata, checksum, archive and redirected assets with TLS verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "abl-proxy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const certPath = fileURLToPath(new URL("fixtures/proxy-test-cert.pem", import.meta.url));
  const cert = await readFile(certPath);
  const key = await readFile(new URL("fixtures/proxy-test-key.pem", import.meta.url));
  const name = "agentbridgelens-extension-1.5.2.zip";
  const zip = createZip([
    { name: "manifest.json", data: JSON.stringify({ name: "AgentBridgeLens", manifest_version: 3, version: "1.5.2", background: { service_worker: "worker.js" }, action: { default_popup: "popup.html" } }) },
    { name: "worker.js", data: "// worker" }, { name: "popup.html", data: "popup" },
  ]);
  const urls = [], connections = [];
  const origin = tlsServer({ cert, key }, (req, res) => {
    urls.push(req.url);
    if (req.url.endsWith("/latest")) res.end(JSON.stringify({ tag_name: "extension-v1.5.2", assets: [{ name }, { name: `${name}.sha256` }] }));
    else if (req.url.endsWith(".sha256")) res.end(`${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
    else if (req.url.endsWith(".zip")) { res.writeHead(302, { Location: "https://release-assets.githubusercontent.com/redirected-archive" }); res.end(); }
    else res.end(zip);
  });
  const originPort = await listen(t, origin);
  const proxy = createServer();
  proxy.on("connect", (req, socket, head) => {
    connections.push(req.url);
    const upstream = connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const fetchImpl = createNetworkFetch(proxyUrl, { env, caFile: certPath, retries: 0 });
  await update(join(root, "extension"), { fetchImpl });
  assert.equal((await validateExtension(join(root, "extension"))).version, "1.5.2");
  assert.ok(connections.includes("api.github.com:443"));
  assert.ok(connections.includes("github.com:443"));
  assert.ok(connections.includes("release-assets.githubusercontent.com:443"));
  assert.ok(urls.includes("/redirected-archive"));
  await assert.rejects(createNetworkFetch(proxyUrl, { env, retries: 0 })("https://api.github.com/test"), /GitHub 下载失败/, "untrusted certificates must still fail");
});

test("proxy connection failures are actionable and redact credentials", async (t) => {
  const port = await listen(t, createServer((_req, res) => { res.writeHead(407); res.end(); }));
  const fetchImpl = createNetworkFetch(`http://name:private-password@127.0.0.1:${port}`, { env, retries: 0 });
  await assert.rejects(fetchImpl("http://example.invalid/"), (error) => {
    assert.match(error.message, /代理要求认证/);
    assert.ok(!error.message.includes("private-password"));
    return true;
  });
  await assert.rejects(createNetworkFetch("http://127.0.0.1:7897", { executable: "abl-curl-not-installed", retries: 0 })("https://api.github.com"), /未找到 curl/);
});

test("SOCKS5 forwards hostname resolution through the proxy", async (t) => {
  const port = await listen(t, createServer((_req, res) => res.end("socks download")));
  const names = [];
  const proxy = socksServer((socket) => {
    let input = Buffer.alloc(0), greeting = true;
    const read = (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (greeting) {
        if (input.length < 2 || input.length < 2 + input[1]) return;
        input = input.subarray(2 + input[1]);
        socket.write(Buffer.from([5, 0])); greeting = false;
      }
      if (input.length < 5) return;
      assert.equal(input[3], 3, "SOCKS5h sends hostname to proxy");
      const size = input[4];
      if (input.length < 7 + size) return;
      names.push(input.subarray(5, 5 + size).toString());
      const remaining = input.subarray(7 + size);
      socket.removeListener("data", read);
      const upstream = connect(port, "127.0.0.1", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (remaining.length) upstream.write(remaining);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      socket.on("close", () => upstream.destroy());
      socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    };
    socket.on("data", read);
  });
  const proxyPort = await listen(t, proxy);
  const fetchImpl = createNetworkFetch(`socks5h://127.0.0.1:${proxyPort}`, { env, retries: 0 });
  assert.equal(await (await fetchImpl("http://only-proxy.invalid/download")).text(), "socks download");
  assert.deepEqual(names, ["only-proxy.invalid"]);
});

test("explicit proxy is remembered after a successful version check without losing the install path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "abl-proxy-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preferenceFile = join(root, "updater.json");
  const selected = [];
  await main(["--dir", join(root, "extension"), "--proxy", "7897", "--retries", "7", "--check"], {
    preferenceFile,
    networkFetch: (proxy, options) => {
      selected.push({ proxy, retries: options.retries });
      return async () => new Response(JSON.stringify({ tag_name: "extension-v1.5.2", assets: [
        {name:"agentbridgelens-extension-1.5.2.zip"}, {name:"agentbridgelens-extension-1.5.2.zip.sha256"},
      ] }));
    },
  });
  const saved = JSON.parse(await readFile(preferenceFile, "utf8"));
  assert.equal(saved.directory, join(await realpath(root), "extension"));
  assert.equal(saved.proxy, "http://127.0.0.1:7897/");
  assert.deepEqual(selected, [{ proxy: "http://127.0.0.1:7897/", retries: 7 }]);
});

test("transient proxy failures retry and an aborted download stops promptly", async (t) => {
  let requests = 0;
  const proxy = createServer((req, res) => {
    requests++;
    if (req.url.endsWith("/wait")) return;
    if (requests === 1) req.socket.destroy();
    else res.end("retried");
  });
  const port = await listen(t, proxy);
  const fetchImpl = createNetworkFetch(`http://127.0.0.1:${port}`, { env, retries: 1 });
  assert.equal(await (await fetchImpl("http://retry.invalid/download")).text(), "retried");
  assert.equal(requests, 2);
  await assert.rejects(fetchImpl("http://retry.invalid/wait", { signal: AbortSignal.timeout(20) }), /超时或已取消/);
});

test("temporary HTTP failures get five attempts with visible exponential backoff", async (t) => {
  let requests = 0;
  const port = await listen(t, createServer((_req, res) => {
    requests++;
    if (requests <= 4) { res.writeHead(503); res.end("unavailable"); }
    else res.end("downloaded");
  }));
  const delays = [], messages = [];
  const fetchImpl = createNetworkFetch(`http://127.0.0.1:${port}`, {
    env, sleep: async (ms) => { delays.push(ms); }, onRetry: (message) => messages.push(message),
  });
  const result = await fetchImpl("http://retry.invalid/archive?token=not-for-logs", { stage: "下载安装包" });
  assert.equal(await result.text(), "downloaded");
  assert.equal(requests, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(messages.length, 4);
  assert.match(messages.at(-1), /第 5\/5 次/);
  assert.ok(messages.every((message) => !message.includes("not-for-logs")));
});

test("persistent proxy CONNECT 403 is identified and only retried once", async (t) => {
  let requests = 0;
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    requests++;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(t, proxy);
  const delays = [];
  await assert.rejects(createNetworkFetch(`http://127.0.0.1:${port}`, {
    env, retries: 9, sleep: async (ms) => { delays.push(ms); }, onRetry() {},
  })("https://api.github.com/example", { stage: "检查最新版本" }), (error) => {
    assert.equal(error.connectStatus, 403);
    assert.equal(error.status, 403);
    assert.match(error.message, /代理 CONNECT 隧道被拒绝/);
    assert.match(error.message, /检查最新版本/);
    assert.match(error.message, /更换出口节点/);
    return true;
  });
  assert.equal(requests, 2);
  assert.deepEqual(delays, [1000]);
});

test("Retry-After is honored, long waits and permanent HTTP errors stop retries", async (t) => {
  let requests = 0;
  const port = await listen(t, createServer((req, res) => {
    requests++;
    if (req.url.endsWith("/retry") && requests === 1) { res.writeHead(429, { "Retry-After": "2" }); res.end(); }
    else if (req.url.endsWith("/retry")) res.end("ok");
    else if (req.url.endsWith("/long")) { res.writeHead(429, { "Retry-After": "120" }); res.end(); }
    else { res.writeHead(404); res.end(); }
  }));
  const delays = [];
  const fetchImpl = createNetworkFetch(`http://127.0.0.1:${port}`, { env, sleep: async (ms) => { delays.push(ms); }, onRetry() {} });
  assert.equal(await (await fetchImpl("http://retry.invalid/retry")).text(), "ok");
  assert.deepEqual(delays, [2000]);
  const before = requests;
  await assert.rejects(fetchImpl("http://retry.invalid/long"), /至少等待 120 秒/);
  await assert.rejects(fetchImpl("http://retry.invalid/missing"), /HTTP 404/);
  assert.equal(requests, before + 2);
  assert.equal(delays.length, 1);
});

test("API quota and CONNECT 403 fall back to release-page redirects on the same proxy", async (t) => {
  for (const deniedByProxy of [false, true]) {
    await t.test(deniedByProxy ? "API proxy CONNECT denied" : "API rate limit exhausted", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "abl-release-fallback-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const certPath = fileURLToPath(new URL("fixtures/proxy-test-cert.pem", import.meta.url));
      const cert = await readFile(certPath), key = await readFile(new URL("fixtures/proxy-test-key.pem", import.meta.url));
      const name = "agentbridgelens-extension-1.6.2.zip";
      const zip = createZip([
        { name: "manifest.json", data: JSON.stringify({ name: "AgentBridgeLens", manifest_version: 3, version: "1.6.2", background: { service_worker: "worker.js" }, action: { default_popup: "popup.html" } }) },
        { name: "worker.js", data: "// worker" }, { name: "popup.html", data: "popup" },
      ]);
      let apiRequests = 0, headRequests = 0;
      const hosts = [], retries = [];
      const origin = tlsServer({ cert, key }, (req, res) => {
        if (req.url.startsWith("/repos/")) {
          apiRequests++;
          res.writeHead(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2000000000" }); res.end();
        } else if (req.url.endsWith("/latest")) {
          headRequests++;
          assert.equal(req.method, "HEAD");
          res.writeHead(302, { Location: "https://github.com/Erhao/AgentBridgeLens/releases/tag/extension-v1.6.2" }); res.end();
        } else if (req.url.includes("/releases/tag/")) res.end();
        else if (req.url.endsWith(".sha256")) res.end(`${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
        else if (req.url.endsWith(".zip")) { res.writeHead(302, { Location: "https://release-assets.githubusercontent.com/archive" }); res.end(); }
        else res.end(zip);
      });
      const originPort = await listen(t, origin);
      const proxy = createServer();
      proxy.on("connect", (req, socket, head) => {
        hosts.push(req.url);
        if (deniedByProxy && req.url === "api.github.com:443") {
          apiRequests++;
          socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        const upstream = connect(originPort, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket);
        });
        socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy()); socket.on("close", () => upstream.destroy());
      });
      const port = await listen(t, proxy);
      const fetchImpl = createNetworkFetch(`http://127.0.0.1:${port}`, { env, caFile: certPath, sleep: async () => {}, onRetry: (message) => retries.push(message) });
      await update(join(root, "extension"), { fetchImpl });
      assert.equal((await validateExtension(join(root, "extension"))).version, "1.6.2");
      assert.equal(apiRequests, deniedByProxy ? 2 : 1, "quota is not hammered; proxy rejection only retries once");
      assert.equal(headRequests, 1);
      assert.equal(retries.length, deniedByProxy ? 1 : 0);
      assert.ok(hosts.includes("api.github.com:443") && hosts.includes("github.com:443") && hosts.includes("release-assets.githubusercontent.com:443"));
    });
  }
});

test("release-page fallback rejects foreign URLs and retry count is bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "abl-release-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const url of ["https://example.com/releases/tag/extension-v1.6.2", "https://github.com/Other/repo/releases/tag/extension-v1.6.2", "http://github.com/Erhao/AgentBridgeLens/releases/tag/extension-v1.6.2", "https://github.com:8443/Erhao/AgentBridgeLens/releases/tag/extension-v1.6.2"]) {
    await assert.rejects(update(join(root, "extension"), { fetchImpl: async (_url, options) => {
      if (options.method !== "HEAD") return new Response(null, { status: 403 });
      const result = new Response(null);
      Object.defineProperty(result, "url", { value: url });
      return result;
    } }), /无法从公开发行页确认版本/);
  }
  assert.equal(parseArgs([]).retries, 4);
  assert.equal(parseArgs(["--retries", "0"]).retries, 0);
  assert.equal(parseArgs(["--retries", "10"]).retries, 10);
  for (const args of [["--retries"], ["--retries", "-1"], ["--retries", "11"], ["--retries", "1.5"]]) assert.throws(() => parseArgs(args));
});

test("temporary proxy CONNECT gateway failures also use the full retry budget", async (t) => {
  let requests = 0;
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    requests++;
    socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(t, proxy);
  const delays = [];
  await assert.rejects(createNetworkFetch(`http://127.0.0.1:${port}`, {
    env, sleep: async (ms) => { delays.push(ms); }, onRetry() {},
  })("https://api.github.com/example"), (error) => {
    assert.equal(error.connectStatus, 503);
    assert.match(error.message, /代理 CONNECT 连接失败/);
    return true;
  });
  assert.equal(requests, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});
