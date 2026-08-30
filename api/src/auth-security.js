import crypto from "node:crypto";
import argon2 from "argon2";
import bcrypt from "bcryptjs";

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

export function validateNewPassword(password) {
  const value = String(password ?? "");
  if (value.length < 12 || value.length > 128 || !/[A-Za-zÀ-ÿ]/.test(value) || !/\d/.test(value)) {
    throw new Error("weak_password");
  }
  return value;
}

export async function hashPassword(password) {
  return argon2.hash(validateNewPassword(password), ARGON2_OPTIONS);
}

export async function rehashVerifiedPassword(password) {
  const value = String(password ?? "");
  if (!value || value.length > 128) throw new Error("invalid_credentials");
  return argon2.hash(value, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash, password) {
  const hash = String(storedHash ?? "");
  const candidate = String(password ?? "");
  try {
    if (hash.startsWith("$argon2id$")) {
      const valid = await argon2.verify(hash, candidate);
      return { valid, needsRehash: valid && argon2.needsRehash(hash, ARGON2_OPTIONS) };
    }
    if (/^\$2[aby]\$/.test(hash)) {
      const valid = await bcrypt.compare(candidate, hash);
      return { valid, needsRehash: valid };
    }
  } catch {
    // The caller receives the same neutral authentication failure for malformed hashes.
  }
  await argon2.verify(
    "$argon2id$v=19$m=19456,t=2,p=1$T29uZVN0YXRpY1NhbHQ$V6W31h6S5a9Q1f3D01dWIGEzDIqJodnO3tZJvV5JE7M",
    candidate,
  ).catch(() => false);
  return { valid: false, needsRehash: false };
}

function decodeEncryptionKey(value) {
  const input = String(value ?? "");
  if (/^[a-f0-9]{64}$/i.test(input)) return Buffer.from(input, "hex");
  const decoded = Buffer.from(input, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("invalid_mfa_encryption_key");
}

export function encryptMfaSecret(secret, encryptionKey) {
  const key = decodeEncryptionKey(encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptMfaSecret(payload, encryptionKey) {
  const key = decodeEncryptionKey(encryptionKey);
  const input = Buffer.from(String(payload), "base64url");
  if (input.length < 29) throw new Error("invalid_mfa_secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
  decipher.setAuthTag(input.subarray(12, 28));
  return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString("utf8");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20) {
  const input = crypto.randomBytes(bytes);
  let bits = "";
  for (const byte of input) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) output += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value).toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error("invalid_totp_secret");
  let bits = "";
  for (const character of normalized) bits += BASE32.indexOf(character).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, "0");
}

export function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  const candidate = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(now / 30_000);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = hotp(secret, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
  }
  return false;
}

export function recoveryCodeDigest(code, serverSecret) {
  return crypto.createHmac("sha256", serverSecret).update(String(code).trim().toUpperCase()).digest("hex");
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => `${crypto.randomBytes(4).toString("hex")}-${crypto.randomBytes(4).toString("hex")}`.toUpperCase());
}
