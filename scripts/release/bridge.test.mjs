import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBridgeRelease } from "./bridge.mjs";

test("Bridge releases require an exact matching stable package version and independent tag", () => {
  assert.equal(validateBridgeRelease("bridge-v0.3.0", { name: "agentbridgelens", version: "0.3.0" }), "0.3.0");
  for (const [tag, pkg] of [
    ["main", { name: "agentbridgelens", version: "0.3.0" }],
    ["bridge-v0.2.0", { name: "agentbridgelens", version: "0.3.0" }],
    ["extension-v0.3.0", { name: "agentbridgelens", version: "0.3.0" }],
    ["bridge-v0.3.0", { name: "other", version: "0.3.0" }],
    ["bridge-v0.3.0-beta.1", { name: "agentbridgelens", version: "0.3.0-beta.1" }],
  ]) assert.throws(() => validateBridgeRelease(tag, pkg), /tag must match/);
});
