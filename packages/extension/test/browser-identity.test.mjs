import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

test("installation ID is generated once in local storage and survives worker restarts", async t => {
  const previous = globalThis.chrome;
  let storage = {};
  let writes = 0;
  globalThis.chrome = { storage: { local: {
    async get() { await Promise.resolve(); return structuredClone(storage); },
    async set(value) { writes++; Object.assign(storage, structuredClone(value)); },
  } } };
  t.after(() => { globalThis.chrome = previous; });
  let imports = 0;
  async function load() {
    const source = await readFile(new URL("../src/background/browser-identity.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    return import(`data:text/javascript;base64,${Buffer.from(outputText + `\n// worker ${imports++}`).toString("base64")}`);
  }
  const first = await load();
  const [a, b] = await Promise.all([first.getBrowserIdentity(), first.getBrowserIdentity()]);
  assert.deepEqual(a, b);
  assert.equal(writes, 1, "concurrent callers cannot create different IDs");
  assert.match(a.browserId, /^[0-9a-f-]{36}$/);
  const restarted = await load();
  assert.deepEqual(await restarted.getBrowserIdentity(), a);
  assert.equal(writes, 1);
  storage = {};
  const independent = await load();
  assert.notEqual((await independent.getBrowserIdentity()).browserId, a.browserId, "fresh installation receives a distinct ID");
});
