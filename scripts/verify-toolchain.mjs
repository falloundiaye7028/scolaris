import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STRICT_NODE = "24.20.0";
export const REQUIRED_NPM = "11.19.1";
export const MANAGED_NODE_RANGE = ">=24.19.0 <25";
export const MANAGED_NPM_RANGE = ">=11.17.0 <12";
const VERCEL_ENVIRONMENTS = new Set(["development", "preview", "production"]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseVersion(value) {
  const match = String(value).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function vercelNodeCompatible(value) {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major === 24 && minor >= 19;
}

export function resolveToolchainMode({ mode, lifecycleEvent, vercel, vercelEnv }) {
  if (mode) return { mode, source: "explicit" };
  if (lifecycleEvent === "preinstall" && vercel === "1" && VERCEL_ENVIRONMENTS.has(vercelEnv)) {
    return { mode: "vercel", source: `vercel-system:${vercelEnv}` };
  }
  return { mode: "", source: "unset" };
}

export function evaluateToolchain({ mode, nodeVersion, npmVersion }) {
  if (mode === "strict") {
    return nodeVersion === STRICT_NODE && npmVersion === REQUIRED_NPM
      ? []
      : [`strict mode requires Node ${STRICT_NODE} and npm ${REQUIRED_NPM}; received Node ${nodeVersion}, npm ${npmVersion || "unknown"}`];
  }
  if (mode === "vercel") {
    const errors = [];
    if (!vercelNodeCompatible(nodeVersion)) errors.push(`Vercel mode requires Node ${MANAGED_NODE_RANGE}; received ${nodeVersion}`);
    if (npmVersion !== REQUIRED_NPM) errors.push(`Vercel mode requires npm ${REQUIRED_NPM}; received ${npmVersion || "unknown"}`);
    return errors;
  }
  return [`unknown SCOLARIS_TOOLCHAIN_MODE: ${mode || "unset"}`];
}

export function verifyRepository({ root = repositoryRoot, mode, nodeVersion, npmVersion }) {
  const errors = evaluateToolchain({ mode, nodeVersion, npmVersion });

  for (const file of [".node-version", ".nvmrc"]) {
    if (fs.readFileSync(path.join(root, file), "utf8").trim() !== STRICT_NODE) errors.push(`${file} is not pinned to ${STRICT_NODE}`);
  }

  for (const relative of ["package.json", "api/package.json"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
    if (manifest.engines?.node !== MANAGED_NODE_RANGE || manifest.engines?.npm !== MANAGED_NPM_RANGE) {
      errors.push(`${relative} engines do not describe the approved managed-runtime compatibility ranges`);
    }
    if (manifest.packageManager !== `npm@${REQUIRED_NPM}`) errors.push(`${relative} packageManager is not exact`);
  }

  const lock = JSON.parse(fs.readFileSync(path.join(root, "api/package-lock.json"), "utf8"));
  if (lock.packages?.[""]?.engines?.node !== MANAGED_NODE_RANGE || lock.packages?.[""]?.engines?.npm !== MANAGED_NPM_RANGE) {
    errors.push("lockfile root engines do not match the approved managed-runtime compatibility ranges");
  }
  const argon = lock.packages?.["node_modules/argon2"];
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.dependencies?.argon2 !== "0.45.1") errors.push("lockfile root does not pin argon2@0.45.1");
  if (argon?.version !== "0.45.1" || !String(argon?.resolved || "").endsWith("/argon2-0.45.1.tgz") || !String(argon?.integrity || "").startsWith("sha512-")) {
    errors.push("argon2 lockfile provenance is incomplete");
  }
  return errors;
}

function run() {
  const nodeVersion = process.version.replace(/^v/, "");
  const npmUserAgent = process.env.npm_config_user_agent || "";
  const npmVersion = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] || process.env.npm_version || "";
  const resolvedMode = resolveToolchainMode({
    mode: process.env.SCOLARIS_TOOLCHAIN_MODE || "",
    lifecycleEvent: process.env.npm_lifecycle_event || "",
    vercel: process.env.VERCEL || "",
    vercelEnv: process.env.VERCEL_ENV || "",
  });
  const errors = verifyRepository({ mode: resolvedMode.mode, nodeVersion, npmVersion });
  if (errors.length) {
    for (const error of errors) console.error(`toolchain_guard_failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `toolchain_guard_ok mode=${resolvedMode.mode} source=${resolvedMode.source} node=${nodeVersion} npm=${npmVersion} argon2=0.45.1`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
