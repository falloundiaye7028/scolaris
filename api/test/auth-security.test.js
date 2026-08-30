import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import {
  createRecoveryCodes,
  decryptMfaSecret,
  encryptMfaSecret,
  hashPassword,
  rehashVerifiedPassword,
  recoveryCodeDigest,
  validateNewPassword,
  verifyPassword,
  verifyTotp,
} from "../src/auth-security.js";

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

test("un ancien mot de passe déjà vérifié migre vers Argon2id sans appliquer la politique de création", async () => {
  const legacyPassword = "Ancien1!";
  assert.throws(() => validateNewPassword(legacyPassword), /weak_password/);
  const legacy = await bcrypt.hash(legacyPassword, 10);
  assert.deepEqual(await verifyPassword(legacy, legacyPassword), { valid: true, needsRehash: true });
  const upgraded = await rehashVerifiedPassword(legacyPassword);
  assert.match(upgraded, /^\$argon2id\$/);
  assert.deepEqual(await verifyPassword(upgraded, legacyPassword), { valid: true, needsRehash: false });
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
