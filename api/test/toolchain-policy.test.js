import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolchain } from "../../scripts/verify-toolchain.mjs";

const accepted = [
  ["strict", "24.20.0", "11.19.1"],
  ["vercel", "24.19.0", "11.19.1"],
  ["vercel", "24.20.0", "11.19.1"],
];

const rejected = [
  ["vercel", "24.18.9", "11.19.1"],
  ["vercel", "25.0.0", "11.19.1"],
  ["vercel", "24.20.0", "11.19.0"],
  ["vercel", "24.20.0", "11.17.0"],
  ["unknown", "24.20.0", "11.19.1"],
  ["", "24.20.0", "11.19.1"],
  ["strict", "24.19.0", "11.19.1"],
  ["strict", "24.20.0", "11.19.0"],
];

for (const [mode, nodeVersion, npmVersion] of accepted) {
  test(`toolchain ${mode} accepte Node ${nodeVersion} et npm ${npmVersion}`, () => {
    assert.deepEqual(evaluateToolchain({ mode, nodeVersion, npmVersion }), []);
  });
}

for (const [mode, nodeVersion, npmVersion] of rejected) {
  test(`toolchain ${mode || "unset"} refuse Node ${nodeVersion} et npm ${npmVersion}`, () => {
    assert.notDeepEqual(evaluateToolchain({ mode, nodeVersion, npmVersion }), []);
  });
}
