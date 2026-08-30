import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tracked = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
if (tracked.status !== 0) process.exit(tracked.status || 1);

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github-token", /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["generic-api-key", /\b(?:api[_-]?key|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{24,}["']/i],
  ["postgres-password", /postgres(?:ql)?:\/\/[^:\s/]+:(?!PASSWORD\b|scolaris_dev\b|scolaris_test_only\b)[^@\s/]{8,}@/i],
];

const findings = [];
for (const file of tracked.stdout.split("\0").filter(Boolean)) {
  if (file === "scripts/scan-secrets.mjs") continue;
  if (/package-lock\.json$|\.png$|\.svg$|\.woff2?$/.test(file)) continue;
  let content;
  try { content = readFileSync(file, "utf8"); } catch { continue; }
  if (content.includes("\0")) continue;
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push({ file, rule });
}

if (findings.length) {
  for (const finding of findings) console.error(`Secret potentiel: ${finding.file} (${finding.rule})`);
  process.exit(1);
}
console.log("Aucun secret à haute confiance détecté dans les fichiers suivis.");
