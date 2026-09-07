import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import {
  ARGON2_MAX_CONCURRENCY,
  ARGON2_POLICY,
  AUTH_PASSWORD_MAX_UTF8_BYTES,
  createRecoveryCodes,
  decryptMfaSecret,
  encryptMfaSecret,
  hashPassword,
  getArgon2Metrics,
  rehashVerifiedPassword,
  recoveryCodeDigest,
  setArgon2DriverForTests,
  validateNewPassword,
  verifyPassword,
  verifyTotp,
} from "../src/auth-security.js";

test("la politique Argon2id centrale est exacte et versionnée", () => {
  assert.equal(ARGON2_POLICY.policyVersion, 1);
  assert.equal(ARGON2_POLICY.variant, "argon2id");
  assert.equal(ARGON2_POLICY.version, 19);
  assert.equal(ARGON2_POLICY.memoryCost, 19_456);
  assert.equal(ARGON2_POLICY.timeCost, 2);
  assert.equal(ARGON2_POLICY.parallelism, 1);
  assert.equal(ARGON2_POLICY.hashLength, 32);
  assert.equal(AUTH_PASSWORD_MAX_UTF8_BYTES, 256);
});

test("les nouveaux mots de passe utilisent Argon2id", async () => {
  const hash = await hashPassword("MotDePasse2026!");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal((await verifyPassword(hash, "MotDePasse2026!")).valid, true);
  assert.equal((await verifyPassword(hash, "incorrect")).valid, false);
  assert.throws(() => validateNewPassword("tropcourt1"), /weak_password/);
});

test("un hash bcrypt valide est marqué pour migration incrémentale", async () => {
  const legacy = await bcrypt.hash("MotDePasse2026!", 10);
  assert.deepEqual(await verifyPassword(legacy, "MotDePasse2026!"), { valid: true, needsRehash: true });
});

test("bcrypt ne migre jamais après un mot de passe invalide", async () => {
  const legacy = await bcrypt.hash("MotDePasse2026!", 10);
  assert.deepEqual(await verifyPassword(legacy, "incorrect"), { valid: false, needsRehash: false });
});

test("un hash Argon2 malformé est rejeté sans fallback bcrypt", async () => {
  assert.deepEqual(await verifyPassword("$argon2id$v=19$malforme", "MotDePasse2026!"), { valid: false, needsRehash: false });
});

test("la limite d’authentification est calculée en octets UTF-8 sans troncature", async () => {
  const ascii255 = `A1${"x".repeat(253)}`;
  const ascii256 = `A1${"x".repeat(254)}`;
  const ascii257 = `A1${"x".repeat(255)}`;
  assert.equal(Buffer.byteLength(ascii255), 255);
  assert.equal(Buffer.byteLength(ascii256), 256);
  assert.equal(Buffer.byteLength(ascii257), 257);
  const hash255 = await rehashVerifiedPassword(ascii255);
  const hash256 = await rehashVerifiedPassword(ascii256);
  assert.equal((await verifyPassword(hash255, ascii255)).valid, true);
  assert.equal((await verifyPassword(hash256, ascii256)).valid, true);
  await assert.rejects(rehashVerifiedPassword(ascii257), /invalid_credentials/);
  assert.deepEqual(await verifyPassword(hash256, ascii257), { valid: false, needsRehash: false });
  const unicode = "ÉcoleSécurisée🔐2026";
  const unicodeHash = await hashPassword(unicode);
  assert.equal((await verifyPassword(unicodeHash, unicode)).valid, true);
});

test("un ancien secret bcrypt de plus de 72 octets migre seulement après vérification", async () => {
  const legacyPassword = `Ancien1!${"z".repeat(80)}`;
  const legacy = await bcrypt.hash(legacyPassword, 10);
  assert.equal((await verifyPassword(legacy, legacyPassword)).needsRehash, true);
  const upgraded = await rehashVerifiedPassword(legacyPassword);
  assert.equal((await verifyPassword(upgraded, legacyPassword)).valid, true);
});

test("les erreurs natives restent génériques et aucune donnée sensible n’est journalisée", async () => {
  const messages = [];
  const original = console.error;
  console.error = (...parts) => messages.push(parts.join(" "));
  setArgon2DriverForTests({
    hash: async () => { throw new Error("native driver detail"); },
    verify: async () => { throw new Error("native driver detail"); },
    needsRehash: () => false,
  });
  try {
    await assert.rejects(hashPassword("MotDePasse2026!"));
    assert.deepEqual(await verifyPassword("$argon2id$v=19$bad", "SecretJamaisLogge1"), { valid: false, needsRehash: false });
  } finally {
    setArgon2DriverForTests();
    console.error = original;
  }
  assert.deepEqual(messages, []);
  assert.doesNotMatch(messages.join(" "), /SecretJamaisLogge1|argon2id|salt/i);
});

test("la concurrence Argon2 est bornée et l’excès est rejeté", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  setArgon2DriverForTests({ hash: async () => { await blocked; return "hash"; }, verify: async () => true, needsRehash: () => false });
  try {
    const running = Array.from({ length: ARGON2_MAX_CONCURRENCY }, () => hashPassword("MotDePasse2026!"));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(hashPassword("MotDePasse2026!"), /invalid_credentials/);
    release();
    await Promise.all(running);
    assert.ok(getArgon2Metrics().peakActive <= ARGON2_MAX_CONCURRENCY);
    assert.ok(getArgon2Metrics().rejected >= 1);
  } finally { release?.(); setArgon2DriverForTests(); }
});

test("un ancien mot de passe déjà vérifié migre vers Argon2id sans appliquer la politique de création", async () => {
  const legacyPassword = "Ancien1!";
  assert.throws(() => validateNewPassword(legacyPassword), /weak_password/);
  const legacy = await bcrypt.hash(legacyPassword, 10);
  assert.deepEqual(await verifyPassword(legacy, legacyPassword), { valid: true, needsRehash: true });
  const upgraded = await rehashVerifiedPassword(legacyPassword);
  assert.match(upgraded, /^\$argon2id\$/);
  assert.deepEqual(await verifyPassword(upgraded, legacyPassword), { valid: true, needsRehash: false });
});

test("un calcul Argon2 bloqué expire avec une erreur générique bornée", async () => {
  setArgon2DriverForTests({ hash: async () => new Promise(() => {}), verify: async () => true, needsRehash: () => false });
  const started = Date.now();
  try {
    await assert.rejects(hashPassword("MotDePasse2026!"), /invalid_credentials/);
    assert.ok(Date.now() - started >= 4_900 && Date.now() - started < 6_500);
    assert.ok(getArgon2Metrics().timedOut >= 1);
  } finally { setArgon2DriverForTests(); }
});

test("les secrets MFA sont chiffrés avec authentification", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP", key);
  assert.doesNotMatch(encrypted, /JBSWY3/);
  assert.equal(decryptMfaSecret(encrypted, key), "JBSWY3DPEHPK3PXP");
  const tampered = Buffer.from(encrypted, "base64url");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptMfaSecret(tampered.toString("base64url"), key));
});

test("la vérification TOTP accepte le vecteur RFC tronqué à six chiffres", () => {
  assert.equal(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", { now: 59_000, window: 0 }), true);
  assert.equal(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "000000", { now: 59_000, window: 0 }), false);
});

test("les codes de récupération sont uniques et hachés", () => {
  const codes = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const digest = recoveryCodeDigest(codes[0], "server-secret");
  assert.equal(digest.length, 64);
  assert.doesNotMatch(digest, new RegExp(codes[0]));
});
