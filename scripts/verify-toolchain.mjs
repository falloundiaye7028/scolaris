import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE = "24.20.0";
const REQUIRED_NPM = "11.19.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`toolchain_guard_failed: ${message}`);
  process.exitCode = 1;
}

const actualNode = process.version.replace(/^v/, "");
const npmUserAgent = process.env.npm_config_user_agent || "";
const actualNpm = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] || process.env.npm_version || "";
if (actualNode !== REQUIRED_NODE) fail(`Node ${REQUIRED_NODE} required; received ${actualNode}`);
if (actualNpm !== REQUIRED_NPM) fail(`npm ${REQUIRED_NPM} required; received ${actualNpm || "unknown"}`);

for (const file of [".node-version", ".nvmrc"]) {
  if (fs.readFileSync(path.join(root, file), "utf8").trim() !== REQUIRED_NODE) fail(`${file} is not pinned to ${REQUIRED_NODE}`);
}

for (const relative of ["package.json", "api/package.json"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  if (manifest.engines?.node !== REQUIRED_NODE || manifest.engines?.npm !== REQUIRED_NPM) fail(`${relative} engines are not exact`);
  if (manifest.packageManager !== `npm@${REQUIRED_NPM}`) fail(`${relative} packageManager is not exact`);
}

const lock = JSON.parse(fs.readFileSync(path.join(root, "api/package-lock.json"), "utf8"));
const argon = lock.packages?.["node_modules/argon2"];
if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.dependencies?.argon2 !== "0.45.1") fail("lockfile root does not pin argon2@0.45.1");
if (argon?.version !== "0.45.1" || !String(argon?.resolved || "").endsWith("/argon2-0.45.1.tgz") || !String(argon?.integrity || "").startsWith("sha512-")) fail("argon2 lockfile provenance is incomplete");

if (!process.exitCode) console.log(`toolchain_guard_ok node=${actualNode} npm=${actualNpm} argon2=0.45.1`);
