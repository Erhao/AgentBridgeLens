import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { once } from "node:events";
const require = createRequire(
  new URL("../../packages/bridge/package.json", import.meta.url),
);
const { build } = require("tsup");
const { WebSocket } = require("ws");
const out = await mkdtemp(
  fileURLToPath(
    new URL("../../packages/bridge/node_modules/.contracts-", import.meta.url),
  ),
);
after(() => rm(out, { recursive: true, force: true }));
await build({
  entry: {
    runtime: fileURLToPath(
      new URL("../../packages/runtime/src/index.ts", import.meta.url),
    ),
    desktop: fileURLToPath(
      new URL("../../packages/desktop/src/index.ts", import.meta.url),
    ),
    protocol: fileURLToPath(
      new URL("../../packages/protocol/src/index.ts", import.meta.url),
    ),
  },
  format: ["esm"],
  outDir: out,
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/^@agentbridgelens\//],
  external: ["ws", "zod"],
  dts: false,
  silent: true,
});
const { PendingRequests, NativeChannel } = await import(
  pathToFileURL(join(out, "runtime.mjs"))
);
const { MacDesktop } = await import(pathToFileURL(join(out, "desktop.mjs")));
const { desktopSchemas, nativeHello, executorResponse } = await import(
  pathToFileURL(join(out, "protocol.mjs"))
);
const { z } = require("zod");

test("shared pending requests reject late/wrong-connection replies and cancel only the requested call", async () => {
  const pending = new PendingRequests(),
    a = {},
    b = {},
    controller = new AbortController();
  const first = pending.create(a, {
    timeoutMs: 1000,
    signal: controller.signal,
  });
  const second = pending.create(a, { timeoutMs: 1000 });
  assert.equal(pending.settle(b, first.id, undefined, "wrong peer"), false);
  const cancelled = assert.rejects(
    first.promise,
    (e) => e.code === "CANCELLED",
  );
  controller.abort();
  await cancelled;
  assert.equal(pending.settle(a, first.id, undefined, "late"), false);
  pending.settle(a, second.id, undefined, "other request");
  assert.equal(await second.promise, "other request");
});

test("native channel authenticates, negotiates v1, rejects replacement clients and rotates session after disconnect", async (t) => {
  const token = "a".repeat(64),
    channel = new NativeChannel({ port: 0, token, timeoutMs: 50 });
  t.after(() => channel.close());
  const port = await channel.listen();
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/native`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await once(ws, "open");
    const ack = once(ws, "message");
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId: "test-mac",
        version: "0.1.2",
        capabilities: ["windows"],
      }),
    );
    assert.equal(JSON.parse((await ack)[0]).type, "hello_ack");
    return ws;
  };
  const peer = await connect(),
    session = channel.status.sessionId;
  const request = once(peer, "message");
  const value = channel.send("mac_get_status", {});
  const wire = JSON.parse((await request)[0]);
  peer.send(
    JSON.stringify({ type: "response", id: wire.id, result: { ready: true } }),
  );
  assert.deepEqual(await value, { ready: true });
  await assert.rejects(
    channel.send("mac_act", {}),
    (e) => e.code === "TIMEOUT",
  );
  const closed = once(peer, "close");
  peer.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const replacement = await connect();
  assert.notEqual(channel.status.sessionId, session);
  replacement.close();
});

function fixture() {
  const status = {
    connected: true,
    sessionId: "native-session",
    device: { version: "0.2.0" },
  };
  const native = {
    permissions: { accessibility: true, screenCapture: true },
    controlEnabled: true,
    controlEpoch: 1,
  };
  const calls = [];
  let count = 0;
  const channel = {
    status,
    close: async () => {},
    send: async (tool, params) => {
      calls.push({ tool, params });
      if (tool === "mac_get_status") return native;
      if (tool === "mac_list_windows")
        return {
          windows: [
            {
              windowRef: "w",
              pid: 1,
              title: "Fixture",
              app: "Fixture",
              frame: { x: -800, y: 0, width: 800, height: 600 },
            },
          ],
        };
      if (tool === "mac_focus_window") return { verified: true };
      if (tool === "mac_observe")
        return {
          snapshotId: `s${++count}`,
          elements: [
            {
              id: "e1",
              role: "AXTextField",
              name: "Name",
              value: "private",
              valueSettable: true,
              enabled: true,
              actions: [],
            },
          ],
          ...(params.screenshot
            ? {
                screenshot: {
                  data: "aGVsbG8=",
                  width: 800,
                  height: 600,
                  mimeType: "image/png",
                },
              }
            : {}),
        };
      if (tool === "mac_act")
        return {
          dispatched: true,
          verified: params.operation.action === "set_value",
        };
      if (tool === "mac_stop") {
        native.controlEnabled = false;
        native.controlEpoch++;
        return { stopped: true };
      }
      throw new Error(tool);
    },
  };
  return { desktop: new MacDesktop(channel), channel, native, calls };
}

test("Mac adapter maps common tools, omits text by default, scopes grants and consumes references", async () => {
  const { desktop, native, calls } = fixture();
  const sessionId = (await desktop.send("desktop_get_capabilities")).sessionId;
  await assert.rejects(
    desktop.send("desktop_list_windows", { sessionId: "old" }),
    (e) => e.code === "STALE_SESSION",
  );
  const tree = await desktop.send("desktop_observe", {
    sessionId,
    windowId: "w",
  });
  assert.equal(tree.nodes[0].text, undefined);
  await assert.rejects(
    desktop.send("desktop_act", {
      sessionId,
      action: "set_text",
      snapshotId: tree.snapshotId,
      target: "e1",
      text: "name",
    }),
    (e) => e.code === "PERMISSION_REQUIRED",
  );
  await desktop.send("desktop_start_session", {
    sessionId,
    windowId: "w",
    input: true,
  });
  const current = await desktop.send("desktop_observe", {
    sessionId,
    windowId: "w",
    includeText: true,
  });
  assert.equal(current.nodes[0].text, "private");
  assert.equal(
    (
      await desktop.send("desktop_act", {
        sessionId,
        action: "set_text",
        snapshotId: current.snapshotId,
        target: "e1",
        text: "name",
      })
    ).verified,
    true,
  );
  await assert.rejects(
    desktop.send("desktop_act", {
      sessionId,
      action: "set_text",
      snapshotId: current.snapshotId,
      target: "e1",
      text: "name",
    }),
    (e) => e.code === "STALE_REFERENCE",
  );
  const image = await desktop.send("desktop_capture_screenshot", { sessionId });
  await desktop.send("desktop_act", {
    sessionId,
    action: "press_keys",
    keys: ["PRIMARY", "S"],
    screenshotId: image.screenshot.screenshotId,
  });
  assert.deepEqual(calls.at(-1).params.operation, {
    action: "key",
    key: "s",
    modifiers: ["command"],
  });
  native.controlEpoch++;
  await assert.rejects(
    desktop.send("desktop_capture_screenshot", { sessionId }),
    (e) => e.code === "CONTROL_DISABLED",
  );
});

test("Mac adapter never restores a grant after stop races with authorization", async () => {
  const { desktop, channel } = fixture();
  let release;
  const old = channel.send;
  channel.send = async (tool, params) => {
    if (tool === "mac_focus_window")
      await new Promise((resolve) => (release = resolve));
    return old(tool, params);
  };
  const starting = desktop.send("desktop_start_session", {
    sessionId: "native-session",
    windowId: "w",
    input: true,
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await desktop.send("desktop_stop");
  release();
  await assert.rejects(starting, (e) => e.code === "CANCELLED");
  await assert.rejects(
    desktop.send("desktop_capture_screenshot", { sessionId: "native-session" }),
    (e) => e.code === "PERMISSION_REQUIRED",
  );
});

test("desktop contract uses named keys on every platform while retaining Linux evdev compatibility", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const schemas = desktopSchemas(platform);
    assert.equal(Object.keys(schemas).length, 9);
    assert.equal(
      z.object(schemas.desktop_act).safeParse({
        sessionId: "s",
        action: "press_keys",
        keys: ["PRIMARY", "S"],
      }).success,
      true,
    );
    assert.equal(
      z
        .object(schemas.desktop_act)
        .safeParse({ sessionId: "s", action: "press_keys", keys: [29, 31] })
        .success,
      platform === "linux",
    );
    assert.equal(
      z.object(schemas.desktop_start_session).safeParse({ sessionId: "s" })
        .success,
      platform === "linux",
    );
  }
});

test("native wire fixture is shared with Swift core checks", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../packages/protocol/fixtures/native-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(nativeHello.parse(fixture.hello).protocolVersion, 1);
  assert.equal(executorResponse.parse(fixture.response).id, fixture.request.id);
  assert.equal(fixture.cancel.id, fixture.request.id);
});

test("released Mac 0.1.x remains compatible with common screenshot depth limits", async () => {
  const { desktop, channel, calls } = fixture();
  channel.status.device.version = "0.1.2";
  await desktop.send("desktop_start_session", {
    sessionId: "native-session",
    windowId: "w",
    input: true,
  });
  await desktop.send("desktop_capture_screenshot", {
    sessionId: "native-session",
  });
  assert.equal(calls.at(-1).params.maxDepth, 1);
});
