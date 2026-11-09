import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const { outputText } = ts.transpileModule(await readFile(new URL("../src/background/content-connection.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { ContentConnection } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function setup(t, { ready = false, url = "https://example.com", deny = false } = {}) {
  const previous = globalThis.chrome;
  const state = { ready, injected: 0, activity: 0, version: "1.6.1" };
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: state.version, content_scripts: [{ js: ["assets/packaged-loader.js"] }] }) },
    tabs: {
      get: async () => ({ url }),
      sendMessage: async (_id, message, options) => {
        assert.equal(options.frameId, 0);
        if (!state.ready) throw new Error("Receiving end does not exist");
        if (message.type === "bridgelens-content-ping") return { ready: true, version: state.version };
        state.activity++;
      },
    },
    scripting: { executeScript: async (options) => {
      state.injected++;
      assert.deepEqual(options.files, ["assets/packaged-loader.js"]);
      assert.deepEqual(options.target.frameIds, [0]);
      if (deny) throw new Error("Cannot access contents of the page");
      state.ready = true;
    } },
  };
  t.after(() => { globalThis.chrome = previous; });
  return state;
}

test("healthy content is reused and concurrent recovery injects the packaged script only once", async (t) => {
  const state = setup(t);
  const connection = new ContentConnection();
  await Promise.all([connection.ensure(1), connection.ensure(1), connection.sendActivity(1, { type: "bridgelens-activities" })]);
  assert.equal(state.injected, 1);
  assert.equal(state.activity, 1);
  await connection.ensure(1);
  assert.equal(state.injected, 1);
});

test("activity broadcast restores missing scripts and resends the status without page navigation", async (t) => {
  const state = setup(t);
  const connection = new ContentConnection();
  await connection.sendActivity(7, { type: "bridgelens-activities" });
  assert.equal(state.injected, 1);
  assert.equal(state.activity, 1);
});

test("restricted pages are not injected; denied permissions are actionable and retries are bounded", async (t) => {
  await t.test("browser-internal page", async (t) => {
    const state = setup(t, { url: "chrome://extensions/" });
    await assert.rejects(new ContentConnection().ensure(1), /普通 HTTP\/HTTPS/);
    assert.equal(state.injected, 0);
  });
  await t.test("permission blocked", async (t) => {
    const state = setup(t, { deny: true });
    const connection = new ContentConnection();
    await assert.rejects(connection.ensure(1), /站点访问权限/);
    await assert.rejects(connection.ensure(1), /站点访问权限/);
    assert.equal(state.injected, 1, "failure cooldown prevents repeated injection");
    state.ready = true;
    await connection.ensure(1);
    assert.equal(state.injected, 1, "freshly working pages bypass old failures");
  });
});
