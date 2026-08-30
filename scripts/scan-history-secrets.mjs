import { spawnSync } from "node:child_process";

const history = spawnSync("git", ["log", "--all", "--no-color", "--format=SCOLARIS_COMMIT:%H", "--patch"], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
if (history.status !== 0) process.exit(history.status || 1);

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github-token", /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["postgres-password", /postgres(?:ql)?:\/\/[^:\s/]+:(?!PASSWORD\b|scolaris_dev\b|scolaris_test_only\b)[^@\s/]{8,}@/i],
];

const findings = new Map();
for (const section of history.stdout.split("SCOLARIS_COMMIT:").slice(1)) {
  const [commit, ...patch] = section.split("\n");
  const content = patch.join("\n");
  for (const [rule, pattern] of rules) {
    if (pattern.test(content)) findings.set(rule, (findings.get(rule) || 0) + 1);
  }
}

if (findings.size) {
  for (const [rule, count] of findings) console.error(`Historique: ${count} révision(s) potentielle(s) pour la règle ${rule}.`);
  process.exit(1);
}
console.log("Aucun secret à haute confiance détecté dans l’historique Git.");
