import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ? path.resolve(process.argv[2]) : null;
const lock = JSON.parse(fs.readFileSync(path.join(root, "api/package-lock.json"), "utf8"));
const dependencies = Object.entries(lock.packages || {})
  .filter(([name]) => name.startsWith("node_modules/"))
  .map(([name, item]) => ({ name: name.replace(/^node_modules\//, ""), version: item.version, license: item.license || null }))
  .sort((a, b) => a.name.localeCompare(b.name));
const forbiddenPattern = /\b(?:AGPL|GPL|SSPL)(?:-\d+(?:\.\d+)?)?(?:-only|-or-later)?\b/i;
const forbidden = dependencies.filter((item) => forbiddenPattern.test(item.license || ""));
const missing = dependencies.filter((item) => !item.license);
const report = { schemaVersion: 1, dependencyCount: dependencies.length, forbidden, missing, dependencies };
if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (forbidden.length || missing.length) {
  console.error(`license_policy_failed dependencies=${dependencies.length} forbidden=${forbidden.length} missing=${missing.length}`);
  process.exit(1);
}
console.log(`license_policy_ok dependencies=${dependencies.length} forbidden=0 missing=0`);
