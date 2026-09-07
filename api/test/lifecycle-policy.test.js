import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = path.resolve(import.meta.dirname, "../..");
const guard = path.join(repository, "scripts/verify-lifecycle-policy.mjs");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "scolaris-lifecycle-policy-"));
  mkdirSync(path.join(root, "api"));
  for (const relative of [".npmrc", "api/.npmrc", "api/package.json", "api/package-lock.json"]) {
    writeFileSync(path.join(root, relative), readFileSync(path.join(repository, relative)));
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [guard], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", LIFECYCLE_POLICY_ROOT: root } });
}

test("la politique lifecycle accepte uniquement argon2@0.45.1", () => {
  const root = fixture();
  try { assert.equal(run(root).status, 0); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("la politique lifecycle échoue pour un nouveau script non examiné", () => {
  const root = fixture();
  try {
    const lockPath = path.join(root, "api/package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath));
    lock.packages["node_modules/unreviewed-fixture"] = { version: "1.0.0", hasInstallScript: true };
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lifecycle_policy_failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
