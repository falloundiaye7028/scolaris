import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolchain, resolveToolchainMode } from "../../scripts/verify-toolchain.mjs";

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

const implicitVercelEnvironments = ["preview", "production", "development"];

for (const vercelEnv of implicitVercelEnvironments) {
  test(`preinstall Vercel résout implicitement le mode pour ${vercelEnv}`, () => {
    const resolved = resolveToolchainMode({
      mode: "",
      lifecycleEvent: "preinstall",
      vercel: "1",
      vercelEnv,
    });
    assert.deepEqual(resolved, { mode: "vercel", source: `vercel-system:${vercelEnv}` });
    assert.deepEqual(
      evaluateToolchain({ mode: resolved.mode, nodeVersion: "24.19.0", npmVersion: "11.19.1" }),
      [],
    );
  });
}

const rejectedImplicitContexts = [
  ["hors preinstall", { mode: "", lifecycleEvent: "test", vercel: "1", vercelEnv: "preview" }],
  ["sans VERCEL", { mode: "", lifecycleEvent: "preinstall", vercel: "", vercelEnv: "preview" }],
  ["sans VERCEL_ENV", { mode: "", lifecycleEvent: "preinstall", vercel: "1", vercelEnv: "" }],
  ["VERCEL_ENV staging", { mode: "", lifecycleEvent: "preinstall", vercel: "1", vercelEnv: "staging" }],
  ["VERCEL_ENV evil", { mode: "", lifecycleEvent: "preinstall", vercel: "1", vercelEnv: "evil" }],
  ["local sans mode", { mode: "", lifecycleEvent: "", vercel: "", vercelEnv: "" }],
  ["GitHub Actions sans mode", { mode: "", lifecycleEvent: "preinstall", vercel: "", vercelEnv: "" }],
];

for (const [label, context] of rejectedImplicitContexts) {
  test(`le contexte implicite ${label} reste refusé`, () => {
    const resolved = resolveToolchainMode(context);
    assert.deepEqual(resolved, { mode: "", source: "unset" });
    assert.notDeepEqual(
      evaluateToolchain({ mode: resolved.mode, nodeVersion: "24.20.0", npmVersion: "11.19.1" }),
      [],
    );
  });
}

test("le mode strict explicite gagne sur le contexte Vercel", () => {
  const resolved = resolveToolchainMode({
    mode: "strict",
    lifecycleEvent: "preinstall",
    vercel: "1",
    vercelEnv: "preview",
  });
  assert.deepEqual(resolved, { mode: "strict", source: "explicit" });
  assert.deepEqual(
    evaluateToolchain({ mode: resolved.mode, nodeVersion: "24.20.0", npmVersion: "11.19.1" }),
    [],
  );
});

test("un mode explicite inconnu reste refusé dans Vercel", () => {
  const resolved = resolveToolchainMode({
    mode: "unknown",
    lifecycleEvent: "preinstall",
    vercel: "1",
    vercelEnv: "preview",
  });
  assert.deepEqual(resolved, { mode: "unknown", source: "explicit" });
  assert.notDeepEqual(
    evaluateToolchain({ mode: resolved.mode, nodeVersion: "24.20.0", npmVersion: "11.19.1" }),
    [],
  );
});
