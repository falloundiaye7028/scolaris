import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.NODE_ENV === "test" && process.env.LIFECYCLE_POLICY_ROOT ? path.resolve(process.env.LIFECYCLE_POLICY_ROOT) : repositoryRoot;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "api/package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "api/package-lock.json"), "utf8"));
const approved = Object.entries(manifest.allowScripts || {}).filter(([, enabled]) => enabled).map(([name]) => name).sort();
const lifecycle = Object.entries(lock.packages || {}).filter(([key, item]) => key.startsWith("node_modules/") && item?.hasInstallScript).map(([key, item]) => `${key.replace(/^node_modules\//, "")}@${item.version}`).sort();

const expected = ["argon2@0.45.1"];
const npmrcFiles = [path.join(root, ".npmrc"), path.join(root, "api/.npmrc")];
const invalidNpmrc = npmrcFiles.some((file) => {
  const text = fs.readFileSync(file, "utf8");
  return !/^strict-allow-scripts=true$/m.test(text) || !/^dangerously-allow-all-scripts=false$/m.test(text) || /^dangerously-allow-all-scripts=true$/m.test(text);
});
if (JSON.stringify(approved) !== JSON.stringify(expected) || JSON.stringify(lifecycle) !== JSON.stringify(expected) || invalidNpmrc) {
  console.error("lifecycle_policy_failed", { approved, lifecycle, invalidNpmrc });
  process.exit(1);
}
console.log("lifecycle_policy_ok approved=argon2@0.45.1 pending=0");
